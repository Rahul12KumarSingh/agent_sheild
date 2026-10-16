// Cursor adapter: hooks.json commands (project, user or enterprise).
// Reference: https://cursor.com/docs/hooks and https://cursor.com/docs/reference/third-party-hooks
//
// Cursor's permission hooks must always answer with JSON: invalid or missing JSON blocks the action.
// Cursor can ask on shell and MCP calls, but not on file reads and not from preToolUse ("ask" is not enforced
// there today): those asks become a deny that tells the agent and the person how to approve.

import type { Decision, ShieldEvent } from "../engine/types.js";
import { askMessage, denyMessage, needsApprovalMessage, noteMessage, outcomeOf } from "./common.js";
import { asInput, canonicalize } from "./tools.js";
import type { Adapter, FormatOptions, HookOutput } from "./types.js";

const CURSOR_EVENTS = new Set([
  "beforeShellExecution", "afterShellExecution", "beforeMCPExecution", "afterMCPExecution", "beforeReadFile", "afterFileEdit",
  "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "subagentStart", "subagentStop", "sessionStart",
  "sessionEnd", "preCompact", "stop", "afterAgentResponse", "afterAgentThought", "beforeTabFileRead", "afterTabFileEdit", "workspaceOpen",
]);

/** Events where Cursor shows its own approval prompt for an "ask". */
const CAN_ASK = new Set(["beforeShellExecution", "beforeMCPExecution"]);
/** Events that gate an action and must answer with a permission. */
const PERMISSION = new Set(["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse", "beforeTabFileRead", "subagentStart"]);

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export function detectCursor(input: Record<string, unknown>): boolean {
  return input.conversation_id !== undefined || input.cursor_version !== undefined || CURSOR_EVENTS.has(String(input.hook_event_name));
}

export function parseCursorInput(input: Record<string, unknown>, headless: boolean): ShieldEvent | null {
  const name = String(input.hook_event_name ?? "");
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots.filter((r): r is string => typeof r === "string") : [];
  const base = {
    agent: "cursor" as const,
    sessionId: text(input.conversation_id) ?? text(input.session_id) ?? "unknown",
    cwd: text(input.cwd) ?? roots[0] ?? process.cwd(),
    headless,
    surface: name,
  };
  const withId = text(input.tool_use_id) ? { toolUseId: String(input.tool_use_id) } : {};
  const renamed = (c: { rawTool?: string }) => (c.rawTool ? { rawTool: c.rawTool } : {});

  switch (name) {
    case "beforeSubmitPrompt":
      return { ...base, kind: "prompt", text: text(input.prompt) ?? "" };
    case "beforeShellExecution": {
      const command = text(input.command) ?? "";
      return { ...base, cwd: text(input.cwd) ?? base.cwd, kind: "action", tool: "Bash", input: { command } };
    }
    case "afterShellExecution":
      return { ...base, kind: "result", tool: "Bash", input: { command: text(input.command) ?? "" }, output: input.output ?? "" };
    case "beforeMCPExecution":
    case "afterMCPExecution": {
      const c = canonicalize(`MCP:${String(input.tool_name ?? "")}`, { ...asInput(input.tool_input), ...(text(input.mcp_server_name) ? { mcp_server_name: input.mcp_server_name } : {}) });
      return name === "beforeMCPExecution"
        ? { ...base, kind: "action", tool: c.tool, input: asInput(input.tool_input) }
        : { ...base, kind: "result", tool: c.tool, input: asInput(input.tool_input), output: input.result_json ?? "" };
    }
    case "beforeReadFile": {
      const c = canonicalize("Read", { file_path: text(input.file_path) ?? "" });
      return { ...base, kind: "action", tool: c.tool, input: c.input };
    }
    case "preToolUse": {
      const c = canonicalize(String(input.tool_name ?? ""), input.tool_input);
      return { ...base, kind: "action", tool: c.tool, input: c.input, ...renamed(c), ...withId };
    }
    case "postToolUse": {
      const c = canonicalize(String(input.tool_name ?? ""), input.tool_input);
      return { ...base, kind: "result", tool: c.tool, input: c.input, output: input.tool_output ?? "", ...renamed(c), ...withId };
    }
    default:
      return null;
  }
}

export function formatCursor(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const coach = opts.coach ?? "always";
  const surface = event.surface ?? "";
  const outcome = outcomeOf(decision, event, CAN_ASK.has(surface));

  if (event.kind === "prompt") {
    if (outcome === "block") {
      const reason = denyMessage(decision, event, coach);
      return { exitCode: 2, stdout: JSON.stringify({ continue: false, user_message: reason }), stderr: reason };
    }
    return { exitCode: 0, stdout: JSON.stringify({ continue: true }) };
  }

  if (event.kind === "action") {
    if (outcome === "block") {
      const reason = denyMessage(decision, event, coach);
      return { exitCode: 2, stdout: JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }), stderr: reason };
    }
    if (outcome === "needs-approval") {
      const reason = needsApprovalMessage(decision, event, opts);
      return { exitCode: 2, stdout: JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }), stderr: reason };
    }
    if (outcome === "ask") {
      const reason = askMessage(decision, opts);
      return { exitCode: 0, stdout: JSON.stringify({ permission: "ask", user_message: reason, agent_message: reason }) };
    }
    return { exitCode: 0, stdout: JSON.stringify({ permission: "allow" }) };
  }

  // A result: a note for the model, nothing else.
  if (outcome === "note" && decision.findings.length > 0) {
    return { exitCode: 0, stdout: JSON.stringify({ additional_context: noteMessage(decision, event, coach) }) };
  }
  return { exitCode: 0, stdout: "{}" };
}

export const cursor: Adapter = {
  id: "cursor",
  detect: detectCursor,
  parse: parseCursorInput,
  format: formatCursor,
  // An event we do not act on still needs an answer when Cursor expects a permission.
  ignore: (input) => ({ exitCode: 0, stdout: PERMISSION.has(String(input.hook_event_name)) ? JSON.stringify({ permission: "allow" }) : "{}" }),
};
