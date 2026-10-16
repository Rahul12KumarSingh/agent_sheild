// GitHub Copilot adapter (Copilot CLI, Copilot cloud agent, and VS Code-compatible hook files).
// Reference: https://docs.github.com/en/copilot/reference/hooks-configuration
//
// Two input shapes reach us:
//   camelCase (events configured as preToolUse, postToolUse, userPromptSubmitted): no event name in the payload,
//     so we tell the events apart by shape (prompt / toolResult / toolName)
//   VS Code compatible (events configured as PreToolUse, ...): hook_event_name with snake_case fields

import type { Decision, ShieldEvent } from "../engine/types.js";
import type { Adapter, FormatOptions, HookOutput } from "./claude.js";

interface CopilotInput {
  // camelCase
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: { resultType?: string; textResultForLlm?: string };
  // VS Code compatible
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: { result_type?: string; text_result_for_llm?: string };
}

/** toolArgs may arrive as a JSON string or as an object. */
function args(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: v };
    } catch {
      return { value: v };
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function parseCopilot(raw: string, headless: boolean): ShieldEvent {
  const i = JSON.parse(raw) as CopilotInput;
  const base = { agent: "copilot" as const, sessionId: i.sessionId ?? i.session_id ?? "unknown", cwd: i.cwd ?? process.cwd(), headless };
  const name = i.hook_event_name;
  const tool = i.toolName ?? i.tool_name ?? "";
  const input = args(i.toolArgs ?? i.tool_input);

  if (name === "UserPromptSubmit" || (!name && typeof i.prompt === "string")) return { ...base, kind: "prompt", text: i.prompt ?? "" };
  if (name === "PostToolUse" || (!name && i.toolResult)) {
    const output = i.toolResult?.textResultForLlm ?? i.tool_result?.text_result_for_llm ?? "";
    return { ...base, kind: "result", tool, input, output };
  }
  if (name === "PreToolUse" || (!name && tool)) return { ...base, kind: "action", tool, input };
  throw new Error(`Unsupported Copilot hook payload${name ? `: ${name}` : ""}`);
}

export function formatCopilot(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const coach = opts.coach ?? "always";
  const rules = decision.findings.map((f) => f.ruleId).join(", ");
  const block = decision.action === "block" || (decision.action === "ask" && event.headless);

  if (event.kind === "action") {
    if (block) {
      const reason = [
        `AgentShield blocked this action [${decision.level} ${decision.score}${rules ? ` ${rules}` : ""}]: ${decision.reason}`,
        decision.safeAlternative ? `Safe alternative: ${decision.safeAlternative}` : "",
        "Do not retry this action in another form.",
      ].filter(Boolean).join("\n");
      // Exit 2 denies on its own; the JSON carries the reason to the agent.
      return { exitCode: 2, stdout: JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }), stderr: reason };
    }
    if (decision.action === "ask") {
      const tip = coach === "always" && decision.safeAlternative ? ` Safer option: ${decision.safeAlternative}` : "";
      return { exitCode: 0, stdout: JSON.stringify({ permissionDecision: "ask", permissionDecisionReason: `AgentShield: ${decision.reason}.${tip}` }) };
    }
    return { exitCode: 0 };
  }

  // Copilot's command hooks cannot block or rewrite a prompt: we record it (console, local log) and stay silent.
  if (event.kind === "prompt") return { exitCode: 0 };

  if (decision.action === "note" && decision.findings.length > 0) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        additionalContext: `AgentShield note [${decision.level} ${rules}]: the output of ${event.tool}: ${decision.reason}. ${decision.safeAlternative ?? ""}`.trim(),
      }),
    };
  }
  return { exitCode: 0 };
}

export const copilot: Adapter = { parse: parseCopilot, format: formatCopilot };
