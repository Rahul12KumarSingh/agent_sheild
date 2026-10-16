import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clip } from "../engine/catalog.js";
import { redactAll } from "../engine/detectors.js";
import type { Action, Category, Decision, Level, ShieldEvent } from "../engine/types.js";

/** What leaves the hook: metadata and a redacted excerpt. Never raw prompts, never secret values. */
export interface ShieldRecord {
  id: string;
  ts: string;
  agent: string;
  /** Short hash of the agent's session id. */
  session: string;
  kind: ShieldEvent["kind"];
  tool?: string;
  summary: string;
  action: Action;
  level: Level;
  score: number;
  rules: string[];
  findings: { ruleId: string; category: Category; level: Exclude<Level, "CLEAN">; reason: string }[];
  reason: string;
  safeAlternative?: string;
  monitored?: Action;
  /** An earlier approval turned an ask into a note. */
  approved?: boolean;
  /** A policy file could not be loaded: the strict built-in rules decided. */
  degraded?: boolean;
  legs: { A?: string; B?: string; C?: string };
  ruleOfTwo: boolean;
  profile?: string;
  /** What the agent app received: exit code and the message. */
  delivered?: { exitCode: number; message?: string };
  /** Seeded or scripted events are labelled. */
  demo?: boolean;
  runId?: string;
  step?: number;
}

export const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

export function summarize(event: ShieldEvent): string {
  let text: string;
  if (event.kind === "prompt") text = event.text;
  else {
    const i = event.input;
    const main = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.filePath ?? i.url ?? i.query ?? i.pattern;
    text = typeof main === "string" ? main : JSON.stringify(i);
  }
  return clip(redactAll(text), 240);
}

export function toRecord(event: ShieldEvent, decision: Decision, extra: Partial<ShieldRecord> = {}): ShieldRecord {
  const s = decision.session;
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    agent: event.agent,
    session: shortHash(event.sessionId),
    kind: event.kind,
    ...(event.kind !== "prompt" ? { tool: event.tool } : {}),
    summary: summarize(event),
    action: decision.action,
    level: decision.level,
    score: decision.score,
    rules: decision.findings.map((f) => f.ruleId),
    findings: decision.findings.map((f) => ({ ruleId: f.ruleId, category: f.category, level: f.level, reason: clip(redactAll(f.reason), 200) })),
    reason: clip(redactAll(decision.reason), 400),
    ...(decision.safeAlternative ? { safeAlternative: clip(redactAll(decision.safeAlternative), 400) } : {}),
    ...(decision.monitored ? { monitored: decision.monitored } : {}),
    ...(decision.approved ? { approved: true } : {}),
    legs: { ...(s?.A ? { A: clip(redactAll(s.A), 160) } : {}), ...(s?.B ? { B: clip(redactAll(s.B), 160) } : {}), ...(s?.C ? { C: clip(redactAll(s.C), 160) } : {}) },
    ruleOfTwo: s?.ruleOfTwo ?? false,
    ...extra,
  };
}

const MAX_LOG = 5 * 1024 * 1024;

/** The local audit log. One JSON line per event, rotated at 5 MB. Never throws. */
export function appendLocalLog(dir: string, entry: object): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    if (existsSync(file) && statSync(file).size > MAX_LOG) renameSync(file, join(dir, "events.1.jsonl"));
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {}
}

/** Best effort: the console may be down or blocked. The decision never depends on this. */
export async function sendToConsole(url: string, record: ShieldRecord, token?: string, timeoutMs = 300): Promise<string | undefined> {
  try {
    const res = await fetch(new URL("/api/events", url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? undefined : `console answered ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
