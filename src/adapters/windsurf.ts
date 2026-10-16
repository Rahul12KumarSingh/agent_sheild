// Windsurf (Devin Desktop Cascade) adapter: hooks.json commands.
// Reference: https://docs.devin.ai/desktop/cascade/hooks
//
// Cascade hooks answer with an exit code only: 2 blocks a pre-hook (stderr goes to the agent), anything else lets the
// action go on. There is no ask, so an ask becomes a deny that tells the agent and the person how to approve.

import type { Decision, ShieldEvent } from "../engine/types.js";
import { denyMessage, needsApprovalMessage, outcomeOf } from "./common.js";
import { asInput, canonicalize } from "./tools.js";
import type { Adapter, FormatOptions, HookOutput } from "./types.js";

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function detectWindsurf(input: Record<string, unknown>): boolean {
  return typeof input.agent_action_name === "string";
}

export function parseWindsurfInput(input: Record<string, unknown>, headless: boolean): ShieldEvent | null {
  const name = String(input.agent_action_name ?? "");
  const info = obj(input.tool_info);
  const base = {
    agent: "windsurf" as const,
    sessionId: text(input.trajectory_id) ?? "unknown",
    cwd: text(info.cwd) ?? process.cwd(),
    headless,
    surface: name,
  };

  switch (name) {
    case "pre_user_prompt":
      return { ...base, kind: "prompt", text: text(info.user_prompt) ?? "" };
    case "pre_run_command":
      return { ...base, kind: "action", tool: "Bash", input: { command: text(info.command_line) ?? "" } };
    case "post_run_command":
      return { ...base, kind: "result", tool: "Bash", input: { command: text(info.command_line) ?? "" }, output: "" };
    case "pre_read_code":
    case "post_read_code": {
      const c = canonicalize("Read", { file_path: text(info.file_path) ?? "" });
      return name === "pre_read_code" ? { ...base, kind: "action", tool: c.tool, input: c.input } : { ...base, kind: "result", tool: c.tool, input: c.input, output: "" };
    }
    case "pre_write_code":
    case "post_write_code": {
      const c = canonicalize("Edit", { file_path: text(info.file_path) ?? "", edits: info.edits });
      return name === "pre_write_code" ? { ...base, kind: "action", tool: c.tool, input: c.input } : { ...base, kind: "result", tool: c.tool, input: c.input, output: "" };
    }
    case "pre_mcp_tool_use":
    case "post_mcp_tool_use": {
      const c = canonicalize(`mcp__${text(info.mcp_server_name) ?? "unknown"}__${text(info.mcp_tool_name) ?? "tool"}`, asInput(info.mcp_tool_arguments));
      return name === "pre_mcp_tool_use" ? { ...base, kind: "action", tool: c.tool, input: c.input } : { ...base, kind: "result", tool: c.tool, input: c.input, output: info.mcp_result ?? "" };
    }
    default:
      return null;
  }
}

export function formatWindsurf(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const outcome = outcomeOf(decision, event, false);
  // Only pre-hooks can block; a result has already happened.
  if (event.kind === "result") return { exitCode: 0 };
  if (outcome === "block") return { exitCode: 2, stderr: denyMessage(decision, event, opts.coach) };
  if (outcome === "needs-approval" || outcome === "ask") return { exitCode: 2, stderr: needsApprovalMessage(decision, event, opts) };
  return { exitCode: 0 };
}

export const windsurf: Adapter = {
  id: "windsurf",
  detect: detectWindsurf,
  parse: parseWindsurfInput,
  format: formatWindsurf,
};
