// Claude Code adapter: hook stdin JSON in, exit code + stdout/stderr out.
// Reference: https://code.claude.com/docs/en/hooks

import type { Decision, ShieldEvent } from "../engine/types.js";
import { approveCommand, askMessage, denyMessage, needsApprovalMessage, noteMessage, outcomeOf } from "./common.js";
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

  const asks = outcome === "ask" || outcome === "needs-approval";

  // AgentShield's own approval: stop, and have the agent ask the user to reply "allow" (see hook/approval.ts).
  if (asks && event.kind === "action" && decision.approval?.state === "needed") {
    const what = decision.approval.summary;
    // Short and readable: no "(+1 more: ...)" tail, long paths cut to their last two parts.
    const reason = decision.reason
      .replace(/\s*\(\+\d+ more:[^)]*\)$/, "")
      .replace(/[.\s]+$/, "")
      .replace(/(?:[a-zA-Z]:)?(?:[\\/][^\s\\/]+){3,}/g, (p) => `…/${p.split(/[\\/]/).slice(-2).join("/")}`);
    // Allow once is what the reply means. Staying quiet for good is a saved approval, which the person has to run themselves.
    const first = (decision.asks ?? []).find((a) => a.rememberable);
    const forGood = first && opts.approvals !== "off" ? `\nTo stop asking for good, the user can run in their terminal: ${approveCommand(first)}` : "";
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `AgentShield paused this step and needs the user's approval. Reason: ${reason}.\n` +
            `Stop now and tell the user in one short message, exactly like this:\n` +
            `"🛡 AgentShield paused: ${what}\nWhy: ${reason}.\nReply allow to run it once.${forGood}"\n` +
            "Do not retry and do not try another way until the user replies allow. If they do, run exactly the same step again.",
        },
        systemMessage: `🛡 AgentShield paused: ${what} · ${reason}. Reply "allow" to run it once.`,
      }),
    };
  }

  if (decision.approval?.state === "granted" && event.kind === "action") {
    return { exitCode: 0, stdout: JSON.stringify({ systemMessage: `🛡 AgentShield: running the step you allowed (${decision.approval.summary}).` }) };
  }

  if (decision.approval?.state === "acknowledged" && event.kind === "prompt") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `AgentShield: the user approved this step once: ${decision.approval.summary}. Run exactly that step again now.`,
        },
        systemMessage: `🛡 AgentShield: allowed once: ${decision.approval.summary}`,
      }),
    };
  }

  if (asks) {
    if (event.kind === "action") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: askMessage(decision, opts) },
          // Shown to the person, so it is clear the approval prompt comes from AgentShield and why.
          systemMessage: `${banner(decision)} Approve only if you expected this step.`,
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
        // Warnings about the user's prompt or a poisoned page are worth a visible line; small notes are not.
        ...(decision.level === "WARNING" || decision.level === "SEVERE" ? { systemMessage: banner(decision) } : {}),
      }),
    };
  }

  return { exitCode: 0 };
}

/** One line a person reads: "🛡 AgentShield · WARNING · SEC-004 · Reads a secret file: .env." */
export function banner(decision: Decision): string {
  const rules = decision.findings.map((f) => f.ruleId).slice(0, 3).join(", ");
  const reason = decision.reason.length > 160 ? `${decision.reason.slice(0, 159)}…` : decision.reason;
  return `🛡 AgentShield · ${decision.level}${rules ? ` · ${rules}` : ""} · ${reason}.`.replace(/\.\.$/, ".");
}

export const claude: Adapter = {
  id: "claude",
  detect: detectClaude,
  parse: parseClaudeInput,
  format: formatClaude,
};
