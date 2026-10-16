// GitHub Copilot adapter: Copilot CLI, Copilot cloud agent, and VS Code agent hooks.
// References: https://docs.github.com/en/copilot/reference/hooks-configuration
//             https://code.visualstudio.com/docs/agents/reference/hooks-reference
//
// Three input shapes reach us:
//   camelCase (events configured as preToolUse, postToolUse, userPromptSubmitted): no event name in the payload,
//     so we tell the events apart by shape (prompt / toolResult / toolName)
//   PascalCase from Copilot CLI or VS Code (PreToolUse, ...): hook_event_name, snake_case fields and an ISO timestamp.
//     Copilot CLI uses it for hooks read from .claude/settings.json; VS Code's Local harness for its own hook files.
//   VS Code Local tool names (run_in_terminal, read_file, ...) are not Claude's: tools.ts translates them.

import type { Decision, ShieldEvent } from "../engine/types.js";
import { askMessage, denyMessage, needsApprovalMessage, noteMessage, outcomeOf } from "./common.js";
import { asInput, canonicalize } from "./tools.js";
import type { Adapter, FormatOptions, HookOutput } from "./types.js";

const PASCAL = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "ErrorOccurred", "Notification", "PermissionRequest"]);

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export function detectCopilot(input: Record<string, unknown>): boolean {
  if (input.agent_action_name !== undefined || input.conversation_id !== undefined) return false;
  const name = input.hook_event_name;
  if (name === undefined) {
    return input.toolName !== undefined || input.sessionId !== undefined || (typeof input.prompt === "string" && typeof input.timestamp === "number");
  }
  return PASCAL.has(String(name)) && typeof input.timestamp === "string";
}

/** The result text from either spelling: Copilot's tool_result / toolResult, or VS Code's tool_response. */
function resultText(input: Record<string, unknown>): unknown {
  const r = (input.toolResult ?? input.tool_result) as Record<string, unknown> | undefined;
  if (r && typeof r === "object") return r.textResultForLlm ?? r.text_result_for_llm ?? r;
  return input.tool_response ?? "";
}

export function parseCopilotInput(input: Record<string, unknown>, headless: boolean): ShieldEvent | null {
  const name = text(input.hook_event_name);
  const camel = name === undefined;
  const base = {
    agent: "copilot" as const,
    sessionId: text(input.sessionId) ?? text(input.session_id) ?? "unknown",
    cwd: text(input.cwd) ?? process.cwd(),
    headless,
  };
  const prefix = camel ? "camel" : "pascal";
  const toolName = text(input.toolName) ?? text(input.tool_name) ?? "";
  const toolUseId = text(input.tool_use_id);

  if (name === "UserPromptSubmit" || (camel && typeof input.prompt === "string")) {
    return { ...base, surface: `${prefix}:UserPromptSubmit`, kind: "prompt", text: text(input.prompt) ?? "" };
  }
  if (name === "PostToolUse" || (camel && (input.toolResult !== undefined || input.tool_result !== undefined) && toolName)) {
    const c = canonicalize(toolName, asInput(input.toolArgs ?? input.tool_input));
    return { ...base, surface: `${prefix}:PostToolUse`, kind: "result", tool: c.tool, input: c.input, output: resultText(input), ...(c.rawTool ? { rawTool: c.rawTool } : {}), ...(toolUseId ? { toolUseId } : {}) };
  }
  if (name === "PreToolUse" || (camel && toolName)) {
    const c = canonicalize(toolName, asInput(input.toolArgs ?? input.tool_input));
    return { ...base, surface: `${prefix}:PreToolUse`, kind: "action", tool: c.tool, input: c.input, ...(c.rawTool ? { rawTool: c.rawTool } : {}), ...(toolUseId ? { toolUseId } : {}) };
  }
  return null;
}

/** The raw-string entry point used by tests and the capture tooling. Invalid JSON throws. */
export function parseCopilot(raw: string, headless: boolean): ShieldEvent | null {
  return parseCopilotInput(JSON.parse(raw) as Record<string, unknown>, headless);
}

export function formatCopilot(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const coach = opts.coach ?? "always";
  const pascal = event.surface?.startsWith("pascal") ?? false;
  const outcome = outcomeOf(decision, event, true);

  if (event.kind === "action") {
    // Copilot answers in camelCase JSON; VS Code (and Copilot CLI for PascalCase hooks) in a nested hookSpecificOutput.
    // Saying it both ways costs nothing: each app reads the fields it knows.
    const answer = (permissionDecision: "deny" | "ask", permissionDecisionReason: string) =>
      JSON.stringify({
        permissionDecision,
        permissionDecisionReason,
        ...(pascal ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } } : {}),
      });
    if (outcome === "block") {
      const reason = denyMessage(decision, event, coach);
      // Exit 2 denies on its own; the JSON carries the reason to the agent.
      return { exitCode: 2, stdout: answer("deny", reason), stderr: reason };
    }
    if (outcome === "ask" || outcome === "needs-approval") return { exitCode: 0, stdout: answer("ask", askMessage(decision, opts)) };
    return { exitCode: 0 };
  }

  if (event.kind === "prompt") {
    // Copilot CLI's command hooks cannot block a prompt: exit 2 shows our reason as a warning and the prompt goes on.
    // VS Code's Local harness stops the turn on exit 2 / continue:false.
    if (outcome === "block") {
      const reason = denyMessage(decision, event, coach);
      return { exitCode: 2, stderr: reason, ...(pascal ? { stdout: JSON.stringify({ continue: false, stopReason: reason }) } : {}) };
    }
    return { exitCode: 0 };
  }

  if (outcome === "note" && decision.findings.length > 0) {
    const additionalContext = noteMessage(decision, event, coach);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ additionalContext, ...(pascal ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } } : {}) }),
    };
  }
  return { exitCode: 0 };
}

export const copilot: Adapter = {
  id: "copilot",
  detect: detectCopilot,
  parse: parseCopilotInput,
  format: formatCopilot,
};
