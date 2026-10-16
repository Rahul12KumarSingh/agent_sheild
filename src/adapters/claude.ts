// Claude Code adapter: hook stdin JSON in, exit code + stdout/stderr out.
// Reference: https://code.claude.com/docs/en/hooks

import type { Decision, ShieldEvent } from "../engine/types.js";
import { askMessage, denyMessage, needsApprovalMessage, noteMessage, outcomeOf } from "./common.js";
import { canonicalize } from "./tools.js";
import type { Adapter, FormatOptions, HookOutput } from "./types.js";

export type { Adapter, FormatOptions, HookOutput } from "./types.js";

const PASCAL_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "SessionEnd", "Stop", "SubagentStop", "PreCompact", "Notification", "PermissionRequest"]);

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Claude Code's payloads: PascalCase event names, no timestamp. (Copilot and VS Code add one.) */
export function detectClaude(input: Record<string, unknown>): boolean {
  return PASCAL_EVENTS.has(String(input.hook_event_name)) && input.timestamp === undefined && input.conversation_id === undefined;
}

export function parseClaudeInput(input: Record<string, unknown>, headless: boolean): ShieldEvent | null {
  const base = {
    agent: "claude" as const,
    sessionId: text(input.session_id) ?? "unknown",
    cwd: text(input.cwd) ?? process.cwd(),
    headless,
    surface: String(input.hook_event_name),
  };

  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return { ...base, kind: "prompt", text: text(input.prompt) ?? "" };
    case "PreToolUse": {
      const c = canonicalize(String(input.tool_name ?? ""), input.tool_input);
      return { ...base, kind: "action", tool: c.tool, input: c.input, ...(c.rawTool ? { rawTool: c.rawTool } : {}), ...(text(input.tool_use_id) ? { toolUseId: String(input.tool_use_id) } : {}) };
    }
    case "PostToolUse": {
      const c = canonicalize(String(input.tool_name ?? ""), input.tool_input);
      return { ...base, kind: "result", tool: c.tool, input: c.input, output: input.tool_response, ...(c.rawTool ? { rawTool: c.rawTool } : {}), ...(text(input.tool_use_id) ? { toolUseId: String(input.tool_use_id) } : {}) };
    }
    default:
      // Session start, stop, compaction ...: nothing for us to judge.
      return null;
  }
}

/** The raw-string entry point used by tests and the capture tooling. Invalid JSON throws. */
export function parseClaude(raw: string, headless: boolean): ShieldEvent | null {
  return parseClaudeInput(JSON.parse(raw) as Record<string, unknown>, headless);
}

export function formatClaude(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const coach = opts.coach ?? "always";
  const outcome = outcomeOf(decision, event, event.kind === "action");

  if (outcome === "block") {
    // Exit code 2 denies in Claude Code, Copilot CLI and Cursor. For a prompt, stderr is shown to the user;
    // for a tool call, it goes to the model, which usually takes the safe alternative.
    return { exitCode: 2, stderr: denyMessage(decision, event, coach) };
  }

  if (outcome === "ask" || outcome === "needs-approval") {
    if (event.kind === "action") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: askMessage(decision, opts) },
        }),
      };
    }
    return { exitCode: 2, stderr: needsApprovalMessage(decision, event, opts) };
  }

  // A note on a prompt or a tool result goes to the model as extra context (e.g. "treat this page as data").
  if (outcome === "note" && event.kind !== "action" && decision.findings.length > 0) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event.kind === "prompt" ? "UserPromptSubmit" : "PostToolUse",
          additionalContext: noteMessage(decision, event, coach),
        },
      }),
    };
  }

  return { exitCode: 0 };
}

export const claude: Adapter = {
  id: "claude",
  detect: detectClaude,
  parse: parseClaudeInput,
  format: formatClaude,
};
