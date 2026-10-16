import { randomUUID } from "node:crypto";
import { ADAPTERS, pickAdapter } from "../adapters/index.js";
import type { HookOutput } from "../adapters/types.js";
import { capturePayload } from "../cli/capture.js";
import { decide, defaultContext, eventSig, type EngineContext } from "../engine/index.js";
import type { Decision, ShieldEvent } from "../engine/types.js";
import { type EffectivePolicy, fallbackPolicy, loadPolicyAsync, userDir } from "../policy/index.js";
import { type AiJudge, aiAllowed, aiInput, applyAi, createAiJudge } from "./ai.js";
import { applyApproval } from "./approval.js";
import { approvalLookup } from "./approvals-store.js";
import { gitDiffSupplier } from "./git.js";
import { gitRemoteUrl, loadSession, saveSession } from "./state.js";
import { appendLocalLog, type ShieldRecord, sendToConsole, toRecord } from "./telemetry.js";

export { ADAPTERS };

export interface HookRunOptions {
  /** The agent the hook file names. Only a hint: the shape of the message decides (one hook file can be read by several apps). */
  agent: string;
  raw: string;
  env?: NodeJS.ProcessEnv;
  captureDir?: string;
  /** The event, when the agent's message does not name it (Antigravity): the hook entry says which one it is. */
  event?: string;
  engine?: EngineContext;
  /** Send to the console and write the local log. Off for the server's own scripted runs. */
  telemetry?: boolean;
  /** Override git remote lookup (scripted scenarios). */
  remoteUrl?: (name: string) => string | undefined;
  /** Extra fields for the record (scenario runs). */
  label?: Partial<ShieldRecord>;
  /** A preloaded policy (the server's demo policy). Otherwise the files are read. */
  policy?: EffectivePolicy;
  /** The live AI judge. "auto" builds one from the policy (the CLI); omitted means rules only (tests, scenarios). */
  ai?: AiJudge | "auto";
}

export interface HookRun {
  output: HookOutput;
  event?: ShieldEvent;
  decision?: Decision;
  policy?: EffectivePolicy;
  record?: ShieldRecord;
}

export const isHeadless = (env: NodeJS.ProcessEnv) => env.AGENTSHIELD_HEADLESS === "1" || env.CI === "true";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Same call twice within this window (two hook files for one event) is counted once. */
const DUPLICATE_MS = 4000;

/**
 * The whole hook: parse the agent's message, load the policy and the session, decide, remember, answer.
 * Fails closed on anything it cannot trust (an unreadable message, an engine crash), but never because it does not
 * understand something harmless: an event it does not act on is a silent yes, and a broken policy file falls back to
 * the strict built-in rules instead of denying every tool. The CLI and the scenario runner share this code.
 */
export async function runHook(opts: HookRunOptions): Promise<HookRun> {
  const env = opts.env ?? process.env;
  const stateDir = userDir(env);

  let input: Record<string, unknown>;
  try {
    capturePayload(opts.agent, opts.raw, opts.captureDir);
    const parsed: unknown = JSON.parse(opts.raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    input = parsed as Record<string, unknown>;
    if (opts.event && input.hook_event_name === undefined) input = { ...input, hook_event_name: opts.event };
  } catch (err) {
    return { output: { exitCode: 2, stderr: `AgentShield could not read the hook message, so the action is denied: ${message(err)}` } };
  }

  const adapter = pickAdapter(opts.agent, input);
  if (!adapter) return { output: { exitCode: 2, stderr: `AgentShield: unsupported agent "${opts.agent}" and the message is not in a format we know. Supported: ${Object.keys(ADAPTERS).join(", ")}` } };

  let event: ShieldEvent | null;
  try {
    event = adapter.parse(input, isHeadless(env));
  } catch (err) {
    return { output: failure(stateDir, "could not understand the hook message", err) };
  }
  if (!event) return { output: adapter.ignore?.(input) ?? { exitCode: 0 } };

  let policy: EffectivePolicy;
  let degraded: string | undefined;
  try {
    policy = opts.policy ?? (await loadPolicyAsync({ cwd: event.cwd, env }));
  } catch (err) {
    degraded = message(err);
    policy = fallbackPolicy(degraded);
  }

  try {
    const session = loadSession(stateDir, event.sessionId);
    const sig = event.kind === "action" ? eventSig(event) : undefined;
    const duplicate = Boolean(sig && session.last && session.last.sig === sig && Date.now() - session.last.at < DUPLICATE_MS);
    const outcome = decide(event, opts.engine ?? defaultContext(), {
      policy,
      session,
      remoteUrl: opts.remoteUrl ?? ((name) => gitRemoteUrl(event.cwd, name)),
      diff: gitDiffSupplier(event.cwd),
      approved: approvalLookup(stateDir, event.cwd),
      duplicate,
    });
    let decision = outcome.decision;
    let nextSession = outcome.session!;
    const aiRequest = opts.ai && aiAllowed(env, event, policy) ? aiInput(event, decision, policy) : undefined;
    if (aiRequest) {
      const judge = opts.ai === "auto" ? createAiJudge({ env, stateDir, endpoint: policy.aiEndpoint }) : opts.ai!;
      decision = applyAi(decision, await judge.judge(aiRequest).catch(() => undefined), event, policy);
    }
    // Claude Code's Yes/No box cannot say who asks or why, so AgentShield runs its own "reply allow" approval there (the message decides, not the hook file).
    if (adapter.id === "claude" && policy.mode !== "monitor") ({ decision, session: nextSession } = applyApproval(event, decision, nextSession));
    saveSession(stateDir, nextSession);
    const output = adapter.format(decision, event, { coach: policy.settings.coach_messages, approvals: policy.settings.approvals });
    if (degraded && output.exitCode === 2 && output.stderr) {
      output.stderr += `\nAgentShield is using its built-in rules because a policy file could not be loaded (${degraded}). Run \`agentshield doctor\`.`;
    }
    const record = toRecord(event, decision, {
      profile: policy.profile,
      delivered: { exitCode: output.exitCode, ...(output.stderr || output.stdout ? { message: (output.stderr ?? output.stdout)!.slice(0, 600) } : {}) },
      ...(degraded ? { degraded: true } : {}),
      ...opts.label,
    });
    if (opts.telemetry !== false && !duplicate) await report(record, policy, env, stateDir);
    return { output, event, decision, policy, record };
  } catch (err) {
    return { event, policy, output: failure(stateDir, "internal error", err) };
  }
}

/** A deny the person can act on: what happened, a reference for the log, and where to look. */
function failure(stateDir: string, what: string, err: unknown): HookOutput {
  const ref = randomUUID().slice(0, 8);
  appendLocalLog(stateDir, { ts: new Date().toISOString(), error: message(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 6).join("\n") : undefined, ref });
  return { exitCode: 2, stderr: `AgentShield ${what} (ref ${ref}), so this action is denied: ${message(err)}\nRun \`agentshield doctor\`; the details are in the local log (events.jsonl).` };
}

async function report(record: ShieldRecord, policy: EffectivePolicy, env: NodeJS.ProcessEnv, stateDir: string): Promise<void> {
  appendLocalLog(stateDir, record);
  if (!policy.consoleUrl) return;
  const problem = await sendToConsole(policy.consoleUrl, record, env.AGENTSHIELD_CONSOLE_TOKEN);
  if (problem) appendLocalLog(stateDir, { ts: new Date().toISOString(), telemetry_error: problem, id: record.id });
}
