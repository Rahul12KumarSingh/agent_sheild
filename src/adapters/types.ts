import type { AgentId, Decision, ShieldEvent } from "../engine/types.js";

export interface HookOutput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface FormatOptions {
  /** When the safer alternative is shown: always, only on a block, or never (an action block still tells the model). */
  coach?: "always" | "on_block" | "off";
  /** What is remembered after a yes (policy `approvals`). Changes what the ask message promises. */
  approvals?: "session" | "saved" | "off";
}

/** One adapter per agent app: its hook format in, its hook format out. The engine never changes. */
export interface Adapter {
  id: AgentId;
  /** Does this payload look like it came from this agent app? Used to pick the adapter, whatever the hook file said. */
  detect(input: Record<string, unknown>): boolean;
  /** Translate the payload. null: an event AgentShield does not act on (session start, stop, a file was formatted ...). */
  parse(input: Record<string, unknown>, headless: boolean): ShieldEvent | null;
  format(decision: Decision, event: ShieldEvent, opts?: FormatOptions): HookOutput;
  /** What to answer for an event we ignore, when the agent app wants an answer anyway (Cursor's permission hooks). */
  ignore?(input: Record<string, unknown>): HookOutput;
}
