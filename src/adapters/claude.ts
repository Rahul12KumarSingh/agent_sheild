// Claude Code adapter: hook stdin JSON in, exit code + stdout/stderr out.
// Reference: https://code.claude.com/docs/en/hooks

import type { Decision, ShieldEvent } from "../engine/types.js";

export interface HookOutput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

interface ClaudeHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

export function parseClaude(raw: string, headless: boolean): ShieldEvent {
  const input = JSON.parse(raw) as ClaudeHookInput;
  const base = {
    agent: "claude" as const,
    sessionId: input.session_id ?? "unknown",
    cwd: input.cwd ?? process.cwd(),
    headless,
  };

  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return { ...base, kind: "prompt", text: input.prompt ?? "" };
    case "PreToolUse":
      return { ...base, kind: "action", tool: input.tool_name ?? "", input: input.tool_input ?? {} };
    case "PostToolUse":
      return {
        ...base,
        kind: "result",
        tool: input.tool_name ?? "",
        input: input.tool_input ?? {},
        output: input.tool_response,
      };
    default:
      throw new Error(`Unsupported Claude Code hook event: ${String(input.hook_event_name)}`);
  }
}

export function formatClaude(decision: Decision, event: ShieldEvent): HookOutput {
  const ask = decision.action === "ask" && !event.headless;
  const block = decision.action === "block" || (decision.action === "ask" && event.headless);

  if (block) {
    // Exit code 2 denies in Claude Code, Copilot CLI and Cursor. For a prompt, stderr is shown to the user;
    // for a tool call, it goes to the model, which usually takes the safe alternative.
    return { exitCode: 2, stderr: denyMessage(decision, event) };
  }

  if (ask && event.kind === "action") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `AgentShield: ${decision.reason}`,
        },
      }),
    };
  }

  // A note on a prompt or a tool result goes to the model as extra context (e.g. "treat this page as data").
  if (decision.action === "note" && event.kind !== "action" && decision.findings.length > 0) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event.kind === "prompt" ? "UserPromptSubmit" : "PostToolUse",
          additionalContext: noteMessage(decision, event),
        },
      }),
    };
  }

  return { exitCode: 0 };
}

function noteMessage(decision: Decision, event: ShieldEvent): string {
  const rules = decision.findings.map((f) => f.ruleId).join(", ");
  const subject = event.kind === "result" ? `The output of ${event.tool}` : "The user's prompt";
  return `AgentShield note [${decision.level} ${rules}]: ${subject}: ${decision.reason}. ${decision.safeAlternative ?? ""}`.trim();
}

function denyMessage(decision: Decision, event: ShieldEvent): string {
  const rules = decision.findings.map((f) => f.ruleId).join(", ");
  const lines = [`AgentShield blocked this ${event.kind === "prompt" ? "prompt" : "action"} [${decision.level} ${decision.score}${rules ? ` ${rules}` : ""}]: ${decision.reason}`];
  if (decision.safeAlternative) {
    lines.push(event.kind === "prompt" ? `Safer prompt: ${decision.safeAlternative}` : `Safe alternative: ${decision.safeAlternative}`);
  }
  if (event.kind !== "prompt") lines.push("Do not retry this action in another form.");
  return lines.join("\n");
}
