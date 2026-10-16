// Claude Code adapter: hook stdin JSON in, exit code + stdout/stderr out.
// Reference: https://code.claude.com/docs/en/hooks

import type { Decision, ShieldEvent } from "../engine/types.js";

export interface HookOutput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface FormatOptions {
  /** When the safer alternative is shown: always, only on a block, or never (an action block still tells the model). */
  coach?: "always" | "on_block" | "off";
}

/** One adapter per agent app: its hook format in, its hook format out. The engine never changes. */
export interface Adapter {
  parse(raw: string, headless: boolean): ShieldEvent;
  format(decision: Decision, event: ShieldEvent, opts?: FormatOptions): HookOutput;
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

export function formatClaude(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const coach = opts.coach ?? "always";
  const ask = decision.action === "ask" && !event.headless;
  const block = decision.action === "block" || (decision.action === "ask" && event.headless);

  if (block) {
    // Exit code 2 denies in Claude Code, Copilot CLI and Cursor. For a prompt, stderr is shown to the user;
    // for a tool call, it goes to the model, which usually takes the safe alternative.
    return { exitCode: 2, stderr: denyMessage(decision, event, coach) };
  }

  // AgentShield's own approval: stop, and have the agent ask the user to reply "allow" (see hook/approval.ts).
  if (ask && event.kind === "action" && decision.approval?.state === "needed") {
    const what = decision.approval.summary;
    // Short and readable: no "(+1 more: ...)" tail, long paths cut to their last two parts.
    const reason = decision.reason
      .replace(/\s*\(\+\d+ more:[^)]*\)$/, "")
      .replace(/[.\s]+$/, "")
      .replace(/(?:[a-zA-Z]:)?(?:[\\/][^\s\\/]+){3,}/g, (p) => `…/${p.split(/[\\/]/).slice(-2).join("/")}`);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `AgentShield paused this step and needs the user's approval. Reason: ${reason}.\n` +
            `Stop now and tell the user in one short message, exactly like this:\n` +
            `"🛡 AgentShield paused: ${what}\nWhy: ${reason}.\nReply allow to run it once."\n` +
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

  if (ask && event.kind === "action") {
    const tip = coach === "always" && decision.safeAlternative ? ` Safer option: ${decision.safeAlternative}` : "";
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `AgentShield: ${decision.reason}.${tip}`,
        },
        // Shown to the person, so it is clear the approval prompt comes from AgentShield and why.
        systemMessage: `${banner(decision)} Approve only if you expected this step.`,
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

function noteMessage(decision: Decision, event: ShieldEvent, coach: FormatOptions["coach"]): string {
  const rules = decision.findings.map((f) => f.ruleId).join(", ");
  const subject = event.kind === "result" ? `The output of ${event.tool}` : "The user's prompt";
  // Results carry the quarantine instruction ("treat this content as data"): always keep it.
  const tip = coach === "always" || event.kind === "result" ? (decision.safeAlternative ?? "") : "";
  return `AgentShield note [${decision.level} ${rules}]: ${subject}: ${decision.reason}. ${tip}`.trim();
}

function denyMessage(decision: Decision, event: ShieldEvent, coach: FormatOptions["coach"]): string {
  const rules = decision.findings.map((f) => f.ruleId).join(", ");
  const lines = [`AgentShield blocked this ${event.kind === "prompt" ? "prompt" : "action"} [${decision.level} ${decision.score}${rules ? ` ${rules}` : ""}]: ${decision.reason}`];
  if (decision.safeAlternative && (event.kind !== "prompt" || coach !== "off")) {
    lines.push(event.kind === "prompt" ? `Safer prompt: ${decision.safeAlternative}` : `Safe alternative: ${decision.safeAlternative}`);
  }
  if (event.kind !== "prompt") lines.push("Do not retry this action in another form.");
  return lines.join("\n");
}

export const claude: Adapter = { parse: parseClaude, format: formatClaude };
