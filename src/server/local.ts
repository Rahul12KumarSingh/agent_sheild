import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Hono } from "hono";
import { evaluate } from "../engine/index.js";
import { draftRules, type RuleDraft, validateDraft } from "../gemini/advisor.js";
import type { Gemini } from "../gemini/client.js";
import { DEFAULT_AI_ENDPOINT } from "../hook/ai.js";
import { isOurs, readSettings, settingsPath } from "../cli/init.js";
import {
  type CustomRule,
  ensureYaml,
  GUARDRAILS,
  type EffectivePolicy,
  mergePolicy,
  type ParsedLayers,
  parseCustomRules,
  parsePolicyFile,
  parseSetting,
  policyPaths,
  readPolicyFile,
  RuleError,
  SchemaError,
  SETTING_KEYS,
  type SettingKey,
  userDir,
} from "../policy/index.js";
import { checkDraft, withRules } from "./rulecheck.js";

// The settings page's API, only on `agentshield setup`: bound to 127.0.0.1, a random token per run,
// and Host / Origin checks so neither another website nor the agent (which never sees the token) can change settings.

export interface LocalOptions {
  token: string;
  /** Where `setup` was started: the project whose settings are edited. */
  cwd: string;
  port: number;
  env: NodeJS.ProcessEnv;
  home?: string;
  /** Gemini with the developer's own key, when GEMINI_API_KEY is set. */
  gemini: Gemini;
  fetcher?: typeof fetch;
}

type Layer = "project" | "user";

/** The repository root (nearest .git), where a project policy belongs. Never the home folder itself. */
export function projectRoot(cwd: string, home = homedir()): string | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 25; i++) {
    if (dir === resolve(home)) return undefined;
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const mtimeOf = (p?: string) => (p && existsSync(p) ? statSync(p).mtimeMs : null);

export function createLocalSettings(opts: LocalOptions) {
  const home = opts.home ?? homedir();
  const env = opts.env;
  // Looked up on every request: the developer may run `git init` while the page is open.
  const rootDir = () => projectRoot(opts.cwd, home);
  const paths = () => {
    const p = policyPaths({ cwd: opts.cwd, env, home });
    const root = rootDir();
    return { company: p.company, project: p.project ?? (root ? join(root, ".agentshield", "policy.yaml") : undefined), user: p.user };
  };

  function readLayers(): { layers: ParsedLayers; errors: Partial<Record<"company" | Layer, string>> } {
    const p = paths();
    const layers: ParsedLayers = {};
    const errors: Partial<Record<"company" | Layer, string>> = {};
    for (const [key, label] of [["company", "company"], ["project", "project"], ["user", "personal"]] as const) {
      const file = p[key];
      if (!file || !existsSync(file)) continue;
      try {
        layers[key] = readPolicyFile(file, label);
      } catch (err) {
        errors[key] = err instanceof Error ? err.message : String(err);
      }
    }
    return { layers, errors };
  }

  const effective = (layers: ParsedLayers): EffectivePolicy => mergePolicy(layers, env.AGENTSHIELD_PROFILE, paths());

  function hooksInstalled() {
    const root = rootDir();
    const has = (path: string) => {
      try {
        const s = readSettings(path);
        return Object.values(s.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isOurs)));
      } catch {
        return false;
      }
    };
    return {
      project: has(settingsPath({ user: false, cwd: root ?? opts.cwd })),
      user: has(settingsPath({ user: true, cwd: opts.cwd, home })),
      copilot: existsSync(join(root ?? opts.cwd, ".github", "hooks", "agentshield.json")),
    };
  }

  function aiEndpoint(layers: ParsedLayers): string {
    try {
      return effective(layers).aiEndpoint ?? DEFAULT_AI_ENDPOINT;
    } catch {
      return DEFAULT_AI_ENDPOINT;
    }
  }

  function state() {
    const root = rootDir();
    const { layers, errors } = readLayers();
    const p = paths();
    let policy: EffectivePolicy | undefined;
    try {
      policy = effective(layers);
    } catch (err) {
      errors.company ??= err instanceof Error ? err.message : String(err);
    }
    const endpoint = aiEndpoint(layers);
    return {
      cwd: opts.cwd,
      projectRoot: root ?? null,
      paths: { company: p.company ?? null, project: p.project ?? null, user: p.user },
      /** The settings file as a person would write it (home folder as ~). */
      userFileDisplay: p.user.startsWith(home) ? `~${p.user.slice(home.length)}` : p.user,
      exists: { project: Boolean(p.project && existsSync(p.project)), user: existsSync(p.user) },
      mtimes: { project: mtimeOf(p.project), user: mtimeOf(p.user) },
      files: { project: layers.project ?? null, user: layers.user ?? null },
      errors,
      policy: policy
        ? { name: policy.name, mode: policy.mode, profile: policy.profile, settings: policy.settings, sources: policy.sources, locked: policy.locked, warnings: policy.warnings, customRules: policy.customRules }
        : null,
      guardrails: GUARDRAILS.map((g) => ({
        id: g.id,
        name: g.name,
        summary: g.summary,
        examples: g.examples,
        on: !(policy?.settings.guardrails_off ?? []).includes(g.id),
        lockedBy: policy?.locked.guardrails_off ?? null,
      })),
      hooks: hooksInstalled(),
      ai: { localKey: Boolean(env.GEMINI_API_KEY), endpoint, via: env.GEMINI_API_KEY ? "your GEMINI_API_KEY (Google AI Studio)" : `the AgentShield cloud (${endpoint})` },
      stateDir: userDir(env, home),
    };
  }

  /** Apply a change to one layer's file, keeping comments, refusing to overwrite a file that changed or is broken. */
  async function save(body: { layer?: unknown; settings?: unknown; customRules?: unknown; expectedMtime?: unknown }) {
    await ensureYaml();
    const { Document, parseDocument } = await import("yaml");
    const layer: Layer | undefined = body.layer === "project" || body.layer === "user" ? body.layer : undefined;
    if (!layer) return { status: 400 as const, body: { error: 'layer must be "project" or "user"' } };
    const file = paths()[layer];
    if (!file) return { status: 400 as const, body: { error: "This folder is not inside a git repository, so there is no project to save to. Use “Just me” instead." } };
    if (mtimeOf(file) !== (body.expectedMtime ?? null)) {
      return { status: 409 as const, body: { error: "The file changed since this page loaded (someone or something edited it). Reload to see the latest, then try again." } };
    }

    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    // A new file gets block style (one setting per line), the way a person would write it.
    const doc = text.trim() ? parseDocument(text) : new Document({});
    if (doc.errors.length) return { status: 422 as const, body: { error: `${file} is not valid YAML, so it was not overwritten. Fix it by hand first: ${doc.errors[0]!.message.split("\n")[0]}` } };
    if (!text.trim()) {
      doc.commentBefore =
        layer === "project"
          ? " AgentShield project policy: applies to everyone who works in this repository.\n Edit with `npx agentshield-hooks setup` or by hand. Rules here can only make AgentShield stricter\n than the company policy, never looser."
          : " AgentShield personal settings. Edit with `npx agentshield-hooks setup` or by hand.";
    }

    const changes = (typeof body.settings === "object" && body.settings !== null ? body.settings : {}) as Record<string, unknown>;
    try {
      for (const [key, value] of Object.entries(changes)) {
        if (!(SETTING_KEYS as string[]).includes(key)) throw new SchemaError(key, "unknown setting");
        if (value === null) doc.delete(key);
        else doc.set(key, parseSetting(key as SettingKey, value, key));
      }
      if (body.customRules !== undefined) {
        const rules = parseCustomRules(body.customRules, "custom_rules");
        if (rules.length) doc.set("custom_rules", rules);
        else doc.delete("custom_rules");
      }
      // The whole file must still be valid, exactly as the hook will read it.
      parsePolicyFile(doc.toJS());
    } catch (err) {
      if (err instanceof SchemaError || err instanceof RuleError) return { status: 422 as const, body: { error: err.message } };
      throw err;
    }

    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, doc.toString({ lineWidth: 0 }));
    renameSync(tmp, file);
    const next = state();
    const prefix = layer === "user" ? "personal config" : "project";
    const ignored = (next.policy?.warnings ?? []).filter((w) => w.startsWith(prefix));
    return { status: 200 as const, body: { ok: true, file, ignored, state: next } };
  }

  function test(body: { text?: unknown; draftRules?: unknown }) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 4000) return { status: 400 as const, body: { error: "Type a command or a prompt (up to 4000 characters)." } };
    let draft: CustomRule[] = [];
    try {
      draft = body.draftRules === undefined ? [] : parseCustomRules(body.draftRules, "draft");
    } catch (err) {
      return { status: 422 as const, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    const { layers } = readLayers();
    const policy = withRules(effective(layers), draft);
    const engine = { home, tmpDirs: [] as string[] };
    const base = { agent: "scripted" as const, sessionId: "settings", cwd: rootDir() ?? opts.cwd, headless: false };
    const asCommand = evaluate({ ...base, kind: "action", tool: "Bash", input: { command: text } }, engine, { policy });
    const asPrompt = evaluate({ ...base, kind: "prompt", text }, engine, { policy });
    const [as, decision] = asPrompt.score > asCommand.score ? (["prompt", asPrompt] as const) : (["command", asCommand] as const);
    return { status: 200 as const, body: { as, decision: { ...decision, session: undefined } } };
  }

  async function draft(body: { description?: unknown }) {
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length < 3 || description.length > 600) return { status: 400 as const, body: { error: "Describe the rule in a sentence or two (3 to 600 characters)." } };
    const { layers } = readLayers();
    let result: RuleDraft;
    let via: string;
    try {
      if (opts.gemini.status.enabled) {
        result = await draftRules(opts.gemini, description);
        via = "your GEMINI_API_KEY";
      } else {
        const endpoint = aiEndpoint(layers);
        const res = await (opts.fetcher ?? fetch)(`${endpoint}/api/ai/draft-rules`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description }),
          signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json().catch(() => ({}))) as { rules?: unknown; examples?: unknown; refused?: unknown; error?: string; model?: string; ms?: number };
        if (!res.ok) throw new Error(json.error ?? `the AgentShield cloud answered ${res.status}`);
        // Never trust the network: validate again with the same parser the policy files use.
        result = { ...validateDraft(json), model: json.model, ms: json.ms };
        via = `the AgentShield cloud (${endpoint})`;
      }
    } catch (err) {
      return {
        status: 503 as const,
        body: { error: `The AI rule writer is not reachable (${err instanceof Error ? err.message.slice(0, 120) : "error"}). You can still add the rule by hand below.` },
      };
    }
    const check = checkDraft(result.rules, result.examples, effective(layers), { cwd: rootDir() ?? opts.cwd, home, tmpDirs: [] });
    return { status: 200 as const, body: { ...result, check, via } };
  }

  return { state, save, test, draft };
}

export function mountLocal(app: Hono, opts: LocalOptions): void {
  const local = createLocalSettings(opts);
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`]);
  const want = Buffer.from(opts.token);

  app.use("/api/local/*", async (c, next) => {
    // DNS rebinding: a web page pointing a hostile name at 127.0.0.1 still sends its own Host.
    if (!hosts.has(c.req.header("host") ?? "")) return c.json({ error: "forbidden host" }, 403);
    // Cross-site requests from any other page in the browser.
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "forbidden origin" }, 403);
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return c.json({ error: "forbidden" }, 403);
    // The token is only in the link `setup` opened in your browser.
    const given = Buffer.from(c.req.header("x-agentshield-token") ?? "");
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return c.json({ error: "This settings link has expired. Run `npx agentshield-hooks setup` again and use the link it opens." }, 401);
    }
    await next();
  });

  app.get("/api/local/state", (c) => c.json(local.state()));
  app.post("/api/local/save", async (c) => {
    const r = await local.save(await c.req.json().catch(() => ({})));
    return c.json(r.body, r.status);
  });
  app.post("/api/local/test", async (c) => {
    const r = local.test(await c.req.json().catch(() => ({})));
    return c.json(r.body, r.status);
  });
  app.post("/api/local/draft", async (c) => {
    const r = await local.draft(await c.req.json().catch(() => ({})));
    return c.json(r.body, r.status);
  });
}
