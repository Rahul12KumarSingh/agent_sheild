import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineContext } from "../engine/index.js";
import type { Action } from "../engine/types.js";
import { runHook } from "../hook/run.js";
import type { ShieldRecord } from "../hook/telemetry.js";
import type { EffectivePolicy } from "../policy/index.js";

// The scripted agent: real Claude Code hook messages, fed through the real hook code path
// (the same runHook the CLI runs), one session per run. Nothing is executed or fetched.

export type Actor = "user" | "agent" | "tool" | "human";

export interface ScenarioStep {
  actor: Actor;
  say: string;
  gate?: 1 | 2 | 3;
  event?: Record<string, unknown>;
  expect?: Action;
  expectRules?: string[];
}

export interface Scenario {
  id: string;
  slug: string;
  title: string;
  headline?: boolean;
  summary: string;
  expected: string;
  cwd: string;
  remotes?: Record<string, string>;
  steps: ScenarioStep[];
  withoutShield: { outcome: string; leak: string };
}

export interface StepResult {
  index: number;
  actor: Actor;
  say: string;
  gate?: number;
  expect?: Action;
  /** What the agent app received from the hook. */
  delivered?: { exitCode: number; message?: string };
  record?: ShieldRecord;
  ok: boolean;
}

export interface ScenarioRun {
  runId: string;
  scenario: Pick<Scenario, "id" | "slug" | "title" | "summary" | "expected" | "withoutShield">;
  steps: StepResult[];
  passed: boolean;
  label: string;
}

/** Same home and temp folder on every machine, so results do not depend on where the server runs. */
export const SCENARIO_ENGINE: EngineContext = { home: "/home/dev", tmpDirs: ["/tmp"] };

const TAGS = /\{\{TAGS:(.*?)\}\}/g;
const expandTags = (s: string) => s.replace(TAGS, (_, t: string) => [...t].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join(""));
const expandDeep = (v: unknown): unknown =>
  typeof v === "string" ? expandTags(v) : Array.isArray(v) ? v.map(expandDeep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x)])) : v;

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir)
    .filter((f) => /^s\d+.*\.json$/.test(f))
    .sort((a, b) => Number(/^s(\d+)/.exec(a)![1]) - Number(/^s(\d+)/.exec(b)![1]))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);
}

export async function runScenario(s: Scenario, opts: { policy: EffectivePolicy; stateDir: string; demo?: boolean }): Promise<ScenarioRun> {
  const runId = randomUUID().slice(0, 8);
  const sessionId = `${s.slug}-${runId}`;
  const env = { AGENTSHIELD_HOME: opts.stateDir } as NodeJS.ProcessEnv;
  const steps: StepResult[] = [];

  for (const [index, step] of s.steps.entries()) {
    if (!step.event) {
      steps.push({ index, actor: step.actor, say: step.say, ok: true });
      continue;
    }
    const payload = {
      session_id: sessionId,
      transcript_path: `/home/dev/.claude/projects/-home-dev-acme-payments/${sessionId}.jsonl`,
      cwd: s.cwd,
      permission_mode: "default",
      ...(expandDeep(step.event) as Record<string, unknown>),
    };
    const res = await runHook({
      agent: "claude",
      raw: JSON.stringify(payload),
      env,
      engine: SCENARIO_ENGINE,
      policy: opts.policy,
      telemetry: false,
      remoteUrl: (name) => s.remotes?.[name],
      label: { agent: "scripted", demo: opts.demo ?? true, runId, step: index },
    });
    const record = res.record;
    const action = record?.action;
    const rulesOk = (step.expectRules ?? []).every((r) => record?.rules.includes(r));
    steps.push({
      index,
      actor: step.actor,
      say: step.say,
      gate: step.gate,
      expect: step.expect,
      delivered: res.output.exitCode !== 0 || res.output.stdout || res.output.stderr
        ? { exitCode: res.output.exitCode, message: (res.output.stderr ?? res.output.stdout)?.slice(0, 600) }
        : { exitCode: 0 },
      record,
      ok: (!step.expect || action === step.expect) && rulesOk,
    });
  }

  return {
    runId,
    scenario: { id: s.id, slug: s.slug, title: s.title, summary: s.summary, expected: s.expected, withoutShield: s.withoutShield },
    steps,
    passed: steps.every((x) => x.ok),
    label: "Scripted agent, real AgentShield",
  };
}
