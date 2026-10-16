import { randomUUID } from "node:crypto";
import { clip } from "../engine/catalog.js";
import { redactAll } from "../engine/detectors.js";
import type { ShieldRecord } from "../hook/telemetry.js";

// In-memory only: a ring buffer of recent redacted events and some counters. No database, nothing on disk.

const ACTIONS = new Set(["block", "ask", "note", "allow"]);
const LEVELS = new Set(["SEVERE", "WARNING", "MILD", "CLEAN"]);
const KINDS = new Set(["prompt", "action", "result"]);
const CATEGORIES = new Set(["SECRET", "PII", "INJECT", "EXFIL", "DESTROY", "EXEC", "PRIV", "SUPPLY", "TAMPER", "SESSION", "GIT"]);

export interface Counters {
  events: number;
  blocked: number;
  asked: number;
  secretsKeptOut: number;
  promptsCoached: number;
  ruleOfTwo: number;
  demoEvents: number;
}

type Listener = (r: ShieldRecord) => void;

export class Feed {
  private buffer: ShieldRecord[] = [];
  private listeners = new Set<Listener>();
  readonly counters: Counters = { events: 0, blocked: 0, asked: 0, secretsKeptOut: 0, promptsCoached: 0, ruleOfTwo: 0, demoEvents: 0 };

  constructor(private readonly size = 300) {}

  add(r: ShieldRecord): void {
    this.buffer.push(r);
    if (this.buffer.length > this.size) this.buffer.shift();
    const c = this.counters;
    c.events++;
    if (r.demo) c.demoEvents++;
    if (r.action === "block") c.blocked++;
    if (r.action === "ask") c.asked++;
    if (r.action === "block" && r.findings.some((f) => f.category === "SECRET" || f.category === "EXFIL" || f.category === "PII")) c.secretsKeptOut++;
    if (r.kind === "prompt" && (r.action === "block" || r.action === "note")) c.promptsCoached++;
    if (r.ruleOfTwo) c.ruleOfTwo++;
    for (const l of this.listeners) {
      try {
        l(r);
      } catch {}
    }
  }

  recent(limit = 100): ShieldRecord[] {
    return this.buffer.slice(-limit);
  }

  find(id: string): ShieldRecord | undefined {
    return this.buffer.find((r) => r.id === id);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get subscribers(): number {
    return this.listeners.size;
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? clip(redactAll(v), max) : undefined);

/**
 * Events from hooks on other machines: never trusted. Keep known fields only, clip every string,
 * redact again (the hook already did), and give the record our own id and time.
 */
export function sanitizeIncoming(body: unknown): ShieldRecord | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (!KINDS.has(String(b.kind)) || !ACTIONS.has(String(b.action)) || !LEVELS.has(String(b.level))) return undefined;
  const score = Number(b.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return undefined;
  const findings = Array.isArray(b.findings)
    ? b.findings.slice(0, 12).flatMap((f) => {
        const x = f as Record<string, unknown>;
        if (typeof x?.ruleId !== "string" || !CATEGORIES.has(String(x.category)) || !LEVELS.has(String(x.level))) return [];
        return [{ ruleId: clip(x.ruleId, 16), category: x.category as ShieldRecord["findings"][number]["category"], level: x.level as ShieldRecord["findings"][number]["level"], reason: str(x.reason, 200) ?? "" }];
      })
    : [];
  const legs = (b.legs && typeof b.legs === "object" ? b.legs : {}) as Record<string, unknown>;
  const delivered = b.delivered && typeof b.delivered === "object" ? (b.delivered as Record<string, unknown>) : undefined;
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    agent: /^(claude|copilot|cursor|windsurf|gemini|scripted)$/.test(String(b.agent)) ? String(b.agent) : "unknown",
    session: str(b.session, 16) ?? "unknown",
    kind: b.kind as ShieldRecord["kind"],
    ...(str(b.tool, 60) ? { tool: str(b.tool, 60) } : {}),
    summary: str(b.summary, 240) ?? "",
    action: b.action as ShieldRecord["action"],
    level: b.level as ShieldRecord["level"],
    score: Math.round(score),
    rules: findings.map((f) => f.ruleId),
    findings,
    reason: str(b.reason, 400) ?? "",
    ...(str(b.safeAlternative, 400) ? { safeAlternative: str(b.safeAlternative, 400) } : {}),
    ...(ACTIONS.has(String(b.monitored)) ? { monitored: b.monitored as ShieldRecord["action"] } : {}),
    ...(b.approved === true ? { approved: true } : {}),
    legs: {
      ...(str(legs.A, 160) ? { A: str(legs.A, 160) } : {}),
      ...(str(legs.B, 160) ? { B: str(legs.B, 160) } : {}),
      ...(str(legs.C, 160) ? { C: str(legs.C, 160) } : {}),
    },
    ruleOfTwo: b.ruleOfTwo === true,
    ...(str(b.profile, 30) ? { profile: str(b.profile, 30) } : {}),
    ...(delivered && Number.isInteger(delivered.exitCode) ? { delivered: { exitCode: Number(delivered.exitCode), ...(str(delivered.message, 600) ? { message: str(delivered.message, 600) } : {}) } } : {}),
  };
}

/** Fixed-window limiter per client and bucket. Memory is bounded by pruning old windows. */
export class RateLimiter {
  private hits = new Map<string, { window: number; count: number }>();

  constructor(private readonly windowMs = 60_000) {}

  allow(key: string, limit: number, now = Date.now()): boolean {
    const window = Math.floor(now / this.windowMs);
    const entry = this.hits.get(key);
    if (!entry || entry.window !== window) {
      if (this.hits.size > 10_000) this.prune(window);
      this.hits.set(key, { window, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }

  private prune(window: number) {
    for (const [k, v] of this.hits) if (v.window !== window) this.hits.delete(k);
  }
}
