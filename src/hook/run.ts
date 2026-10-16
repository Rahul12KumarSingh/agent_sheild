import { type Adapter, claude, type HookOutput } from "../adapters/claude.js";
import { copilot } from "../adapters/copilot.js";
import { capturePayload } from "../cli/capture.js";
import { decide, defaultContext, type EngineContext } from "../engine/index.js";
import type { Decision, ShieldEvent } from "../engine/types.js";
import { type EffectivePolicy, loadPolicyAsync, userDir } from "../policy/index.js";
import { type AiJudge, aiAllowed, aiInput, applyAi, createAiJudge } from "./ai.js";
import { applyApproval } from "./approval.js";
import { gitRemoteUrl, loadSession, saveSession } from "./state.js";
import { appendLocalLog, type ShieldRecord, sendToConsole, toRecord } from "./telemetry.js";

export const ADAPTERS: Record<string, Adapter> = { claude, copilot };

export interface HookRunOptions {
  agent: string;
  raw: string;
  env?: NodeJS.ProcessEnv;
  captureDir?: string;
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

/**
 * The whole hook: parse the agent's message, load the policy and the session, decide, remember, answer.
 * Fails closed: any error denies with an explanation. The CLI and the scenario runner share this code.
 */
export async function runHook(opts: HookRunOptions): Promise<HookRun> {
  const env = opts.env ?? process.env;
  const adapter = ADAPTERS[opts.agent];
  if (!adapter) return { output: { exitCode: 2, stderr: `AgentShield: unsupported agent "${opts.agent}". Supported: ${Object.keys(ADAPTERS).join(", ")}` } };

  let event: ShieldEvent;
  try {
    capturePayload(opts.agent, opts.raw, opts.captureDir);
    event = adapter.parse(opts.raw, isHeadless(env));
  } catch (err) {
    return { output: { exitCode: 2, stderr: `AgentShield internal error, action denied: ${message(err)}` } };
  }

  let policy: EffectivePolicy;
  try {
    policy = opts.policy ?? (await loadPolicyAsync({ cwd: event.cwd, env }));
  } catch (err) {
    const what = event.kind === "prompt" ? "prompt" : "action";
    return { event, output: { exitCode: 2, stderr: `AgentShield policy could not be loaded, so this ${what} is denied: ${message(err)}\nFix the file, then run \`agentshield doctor\`.` } };
  }

  const stateDir = userDir(env);
  try {
    const session = loadSession(stateDir, event.sessionId);
    const outcome = decide(event, opts.engine ?? defaultContext(), {
      policy,
      session,
      remoteUrl: opts.remoteUrl ?? ((name) => gitRemoteUrl(event.cwd, name)),
    });
    let decision = outcome.decision;
    let nextSession = outcome.session!;
    const aiRequest = opts.ai && aiAllowed(env, event, policy) ? aiInput(event, decision, policy) : undefined;
    if (aiRequest) {
      const judge = opts.ai === "auto" ? createAiJudge({ env, stateDir, endpoint: policy.aiEndpoint }) : opts.ai!;
      decision = applyAi(decision, await judge.judge(aiRequest).catch(() => undefined), event, policy);
    }
    // Claude Code's Yes/No box cannot say who asks or why, so AgentShield runs its own "reply allow" approval there.
    if (opts.agent === "claude" && policy.mode !== "monitor") ({ decision, session: nextSession } = applyApproval(event, decision, nextSession));
    saveSession(stateDir, nextSession);
    const output = adapter.format(decision, event, { coach: policy.settings.coach_messages });
    const record = toRecord(event, decision, {
      profile: policy.profile,
      delivered: { exitCode: output.exitCode, ...(output.stderr || output.stdout ? { message: (output.stderr ?? output.stdout)!.slice(0, 600) } : {}) },
      ...opts.label,
    });
    if (opts.telemetry !== false) await report(record, policy, env, stateDir);
    return { output, event, decision, policy, record };
  } catch (err) {
    return { event, policy, output: { exitCode: 2, stderr: `AgentShield internal error, action denied: ${message(err)}` } };
  }
}

async function report(record: ShieldRecord, policy: EffectivePolicy, env: NodeJS.ProcessEnv, stateDir: string): Promise<void> {
  appendLocalLog(stateDir, record);
  if (!policy.consoleUrl) return;
  const problem = await sendToConsole(policy.consoleUrl, record, env.AGENTSHIELD_CONSOLE_TOKEN);
  if (problem) appendLocalLog(stateDir, { ts: new Date().toISOString(), telemetry_error: problem, id: record.id });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
