// Antigravity CLI adapter: hooks.json commands.
// Reference: https://antigravity.google/docs/hooks
//
// The payload has no event name and uses camelCase: { conversationId, workspacePaths, toolCall: { name, args }, stepIdx }.
// So the hook entry names the event itself (`hook antigravity --event PostToolUse`) and the runner adds it as hook_event_name.
// A PreToolUse answer is JSON on stdout: decision allow | deny | ask | force_ask, with a reason. A PostToolUse hook sees the
// call and an error, never the result, so legs of the Rule of Two come from what was asked for, not from what came back.
// There is no prompt hook: prompts are not seen.

import type { Decision, ShieldEvent } from "../engine/types.js";
import { askMessage, denyMessage, outcomeOf } from "./common.js";
import { canonicalize } from "./tools.js";
import type { Adapter, FormatOptions, HookOutput } from "./types.js";

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function detectAntigravity(input: Record<string, unknown>): boolean {
  return typeof input.conversationId === "string" && (typeof input.toolCall === "object" || Array.isArray(input.workspacePaths));
}

export function parseAntigravityInput(input: Record<string, unknown>, headless: boolean): ShieldEvent | null {
  const surface = text(input.hook_event_name) ?? "PreToolUse";
  const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths.filter((p): p is string => typeof p === "string") : [];
  const base = {
    agent: "antigravity" as const,
    sessionId: text(input.conversationId) ?? "unknown",
    cwd: workspaces[0] ?? text(obj(obj(input.toolCall).args).Cwd) ?? process.cwd(),
    headless,
    surface,
  };
  if (surface !== "PreToolUse" && surface !== "PostToolUse") return null;
  const call = obj(input.toolCall);
  const c = canonicalize(String(call.name ?? ""), call.args);
  const tool = { tool: c.tool, input: c.input, ...(c.rawTool ? { rawTool: c.rawTool } : {}) };
  return surface === "PreToolUse" ? { ...base, kind: "action", ...tool } : { ...base, kind: "result", ...tool, output: text(input.error) ?? "" };
}

export function formatAntigravity(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const outcome = outcomeOf(decision, event, true);
  if (event.kind === "result") return { exitCode: 0, stdout: "{}" };
  if (event.kind === "prompt") return { exitCode: 0 };
  const say = (verdict: string, reason?: string): HookOutput => ({ exitCode: 0, stdout: JSON.stringify({ decision: verdict, ...(reason ? { reason } : {}) }) });
  if (outcome === "block") return say("deny", denyMessage(decision, event, opts.coach));
  // force_ask always prompts: a cached "Always allow" must not skip a question AgentShield asked on purpose.
  if (outcome === "ask" || outcome === "needs-approval") return say("force_ask", askMessage(decision, opts));
  // "allow" hands the call on to the app's own permission rules: AgentShield never approves.
  return say("allow");
}

export const antigravity: Adapter = {
  id: "antigravity",
  detect: detectAntigravity,
  parse: parseAntigravityInput,
  format: formatAntigravity,
};
