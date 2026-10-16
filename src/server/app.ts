import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { RULES } from "../engine/catalog.js";
import { riskySpans, rewritePrompt } from "../engine/detectors.js";
import { evaluate } from "../engine/index.js";
import type { Decision } from "../engine/types.js";
import { applyJudge, explain, type JudgeResult, judge, type Rewrite, rewrite } from "../gemini/advisor.js";
import type { Gemini } from "../gemini/client.js";
import type { ShieldRecord } from "../hook/telemetry.js";
import { type EffectivePolicy, mergePolicy, type PolicyFile } from "../policy/index.js";
import { Feed, RateLimiter, sanitizeIncoming } from "./feed.js";
import { runScenario, type Scenario } from "./scenarios.js";

export interface AppOptions {
  /** The demo company policy, as parsed YAML. Profiles are merged from it on demand. */
  company: PolicyFile;
  scenarios: Scenario[];
  /** Where scripted runs keep their session files. */
  stateDir: string;
  gemini: Gemini;
  /** The built console (index.html and assets). */
  consoleDir?: string;
  /** When set, POST /api/events needs `Authorization: Bearer <token>`. */
  ingestToken?: string;
  /** Accept hook events without a token. Off on Cloud Run unless a token is set. */
  ingestOpen?: boolean;
  version?: string;
}

const MAX_SSE = 200;
const LIMITS = { evaluate: 30, scenario: 20, explain: 12, ingest: 240 } as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const PLACEHOLDER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AgentShield</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px"><h1>AgentShield</h1>
<p>The API is running. The console has not been built: run <code>npm run build</code>.</p></body></html>`;

export function createApp(opts: AppOptions) {
  const app = new Hono();
  const feed = new Feed();
  const limiter = new RateLimiter();
  const profiles = new Map<string, EffectivePolicy>();
  const policyFor = (profile?: string): EffectivePolicy => {
    const key = profile || "";
    let p = profiles.get(key);
    if (!p) {
      p = mergePolicy({ company: opts.company }, profile || undefined);
      profiles.set(key, p);
    }
    return p;
  };
  const basePolicy = policyFor();
  const geminiCache = new Map<string, { judge?: JudgeResult; rewrite?: Rewrite }>();
  const explainCache = new Map<string, { text: string; ms: number; model: string }>();
  let sse = 0;

  const clientIp = (c: Context) => {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
    try {
      return getConnInfo(c).remote.address ?? "local";
    } catch {
      return "local";
    }
  };
  const limited = (c: Context, bucket: keyof typeof LIMITS) => !limiter.allow(`${bucket}:${clientIp(c)}`, LIMITS[bucket]);
  const tooMany = (c: Context) => c.json({ error: "Too many requests. Try again in a minute." }, 429);

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: "no-referrer",
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request too large (16 KB max)." }, 413) }));
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/api/info", (c) =>
    c.json({
      name: "AgentShield",
      version: opts.version ?? "dev",
      policy: { name: basePolicy.name, mode: basePolicy.mode, profile: basePolicy.profile },
      gemini: opts.gemini.status,
      counters: feed.counters,
      demo: true,
    }),
  );

  // ---------- Live feed ----------

  app.get("/api/events", (c) => {
    const limit = Math.min(300, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json({ events: feed.recent(limit), counters: feed.counters });
  });

  app.post("/api/events", async (c) => {
    if (limited(c, "ingest")) return tooMany(c);
    if (opts.ingestToken) {
      const given = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
      const want = Buffer.from(opts.ingestToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "unauthorized" }, 401);
    } else if (!opts.ingestOpen) {
      return c.json({ error: "Event ingest is disabled on this server. Set AGENTSHIELD_INGEST_TOKEN." }, 403);
    }
    const record = sanitizeIncoming(await c.req.json().catch(() => undefined));
    if (!record) return c.json({ error: "invalid event" }, 400);
    feed.add(record);
    return c.json({ ok: true, id: record.id }, 201);
  });

  app.get("/api/stream", (c) => {
    if (sse >= MAX_SSE) return c.json({ error: "Too many live viewers. Refresh in a minute." }, 503);
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      sse++;
      const queue: ShieldRecord[] = [];
      let wake: (() => void) | undefined;
      let open = true;
      const unsubscribe = feed.subscribe((r) => {
        queue.push(r);
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ counters: feed.counters }) });
        while (open) {
          while (queue.length && open) {
            const r = queue.shift()!;
            await stream.writeSSE({ event: "shield", id: r.id, data: JSON.stringify({ record: r, counters: feed.counters }) });
          }
          await new Promise<void>((done) => {
            wake = done;
            setTimeout(done, 15_000);
          });
          wake = undefined;
          if (open && queue.length === 0) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      } finally {
        unsubscribe();
        sse--;
      }
    });
  });

  // ---------- Prompt Coach ----------

  app.post("/api/evaluate", async (c) => {
    if (limited(c, "evaluate")) return tooMany(c);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; mode?: unknown; profile?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim() || text.length > 8000) return c.json({ error: "Send 1 to 8000 characters of text." }, 400);
    const profile = typeof body.profile === "string" && /^[a-z][a-z0-9_-]{0,30}$/.test(body.profile) ? body.profile : undefined;
    let policy: EffectivePolicy;
    try {
      policy = policyFor(profile);
    } catch {
      return c.json({ error: `Unknown profile "${profile}".` }, 400);
    }
    const mode = body.mode === "command" || body.mode === "prompt" ? body.mode : "auto";
    const base = { agent: "scripted" as const, sessionId: "coach", cwd: "/home/dev/acme-payments", headless: false };
    const engine = { home: "/home/dev", tmpDirs: ["/tmp"] };
    const asPrompt = evaluate({ ...base, kind: "prompt", text }, engine, { policy });
    const asCommand = evaluate({ ...base, kind: "action", tool: "Bash", input: { command: text } }, engine, { policy });
    const as = mode === "auto" ? (asCommand.score > asPrompt.score ? "command" : "prompt") : mode;
    let decision: Decision = as === "command" ? asCommand : asPrompt;

    let judged: JudgeResult | undefined;
    let rewritten: Rewrite | undefined;
    const key = createHash("sha256").update(`${policy.profile}\n${as}\n${text}`).digest("hex");
    const cached = geminiCache.get(key);
    if (as === "prompt") {
      const template = decision.level === "CLEAN" ? undefined : (decision.safeAlternative ?? rewritePrompt(text));
      const [j, r] = await Promise.all([
        cached?.judge ?? (decision.level !== "SEVERE" && opts.gemini.status.enabled ? judge(opts.gemini, text).catch(() => undefined) : undefined),
        template ? (cached?.rewrite ?? rewrite(opts.gemini, text, template, { policy })) : undefined,
      ]);
      judged = j;
      rewritten = r;
      decision = applyJudge(decision, judged, "prompt", policy.settings.warning_action);
      if (!rewritten && decision.level !== "CLEAN") rewritten = { text: decision.safeAlternative ?? rewritePrompt(text), source: "template" };
      if (judged || rewritten?.source === "gemini") {
        if (geminiCache.size > 200) geminiCache.delete(geminiCache.keys().next().value!);
        geminiCache.set(key, { judge: judged, rewrite: rewritten?.source === "gemini" ? rewritten : undefined });
      }
    }
    feed.counters.promptsCoached++;
    return c.json({
      as,
      profile: policy.profile,
      decision: { ...decision, session: undefined },
      spans: riskySpans(text, { packs: policy.settings.pii, allowTestData: policy.settings.allow_test_data }),
      rewrite: rewritten ?? null,
      judge: judged ?? null,
      gemini: opts.gemini.status,
    });
  });

  // ---------- Scenarios ----------

  app.get("/api/scenarios", (c) =>
    c.json({
      label: "Scripted agent, real AgentShield",
      scenarios: opts.scenarios.map((s) => ({ id: s.id, slug: s.slug, title: s.title, headline: s.headline ?? false, summary: s.summary, expected: s.expected, steps: s.steps.length })),
    }),
  );

  app.post("/api/scenarios/:id/run", async (c) => {
    if (limited(c, "scenario")) return tooMany(c);
    const id = c.req.param("id").toLowerCase();
    const s = opts.scenarios.find((x) => x.id.toLowerCase() === id || x.slug === id);
    if (!s) return c.json({ error: "unknown scenario" }, 404);
    const run = await runScenario(s, { policy: basePolicy, stateDir: opts.stateDir });
    for (const step of run.steps) if (step.record) feed.add(step.record);
    return c.json(run);
  });

  // ---------- Policy ----------

  app.get("/api/policy", (c) => {
    const profile = c.req.query("profile");
    let p: EffectivePolicy;
    try {
      p = policyFor(profile && /^[a-z][a-z0-9_-]{0,30}$/.test(profile) ? profile : undefined);
    } catch {
      return c.json({ error: "unknown profile" }, 400);
    }
    return c.json({
      name: p.name,
      mode: p.mode,
      profile: p.profile,
      settings: p.settings,
      sources: p.sources,
      locked: p.locked,
      profiles: p.profiles,
      rules: Object.entries(RULES).map(([id, r]) => ({ id, category: r.category, level: r.level, title: r.title, alternative: r.alternative })),
    });
  });

  // ---------- Gemini explanation for one event ----------

  app.post("/api/explain", async (c) => {
    if (limited(c, "explain")) return tooMany(c);
    if (!opts.gemini.status.enabled) return c.json({ error: "Gemini is not configured on this server." }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
    const record = typeof body.id === "string" ? feed.find(body.id) : undefined;
    if (!record) return c.json({ error: "unknown event (it may have scrolled out of the live buffer)" }, 404);
    const hit = explainCache.get(record.id);
    if (hit) return c.json(hit);
    try {
      const out = await explain(opts.gemini, record);
      if (!out) return c.json({ error: "no explanation" }, 502);
      explainCache.set(record.id, out);
      if (explainCache.size > 300) explainCache.delete(explainCache.keys().next().value!);
      return c.json(out);
    } catch (err) {
      return c.json({ error: `Gemini did not answer in time (${err instanceof Error ? err.message.slice(0, 60) : "error"}).` }, 504);
    }
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---------- The console (static files, single-page app) ----------

  const root = opts.consoleDir ? resolve(opts.consoleDir) : undefined;
  const index = root && existsSync(resolve(root, "index.html")) ? readFileSync(resolve(root, "index.html")) : undefined;
  app.get("*", (c) => {
    if (!root || !index) return c.html(PLACEHOLDER);
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("bad request", 400);
    }
    const file = resolve(root, `.${path}`);
    if ((file.startsWith(root + sep) || file === root) && path !== "/" && existsSync(file) && statSync(file).isFile()) {
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      const immutable = path.startsWith("/assets/");
      return c.body(readFileSync(file), 200, {
        "Content-Type": type,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
      });
    }
    return c.body(index, 200, { "Content-Type": MIME[".html"]!, "Cache-Control": "no-cache" });
  });

  /** Seed the feed with labelled demo runs so the first visit is not an empty page. */
  async function seed(ids = ["S10", "S4", "S1"]): Promise<void> {
    for (const id of ids) {
      const s = opts.scenarios.find((x) => x.id === id);
      if (!s) continue;
      const run = await runScenario(s, { policy: basePolicy, stateDir: opts.stateDir });
      for (const step of run.steps) if (step.record) feed.add(step.record);
    }
  }

  return { app, feed, seed };
}
