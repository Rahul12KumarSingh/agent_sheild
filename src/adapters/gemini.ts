// Gemini CLI adapter: hooks in settings.json (BeforeTool, AfterTool, BeforeAgent).
// Reference: https://geminicli.com/docs/hooks/reference/
//
// Exit code 2 blocks (stderr is the reason sent to the agent); stdout must hold nothing but the final JSON.
// There is no ask, so an ask becomes a deny that tells the agent and the person how to approve.

import type { Decision, ShieldEvent } from "../engine/types.js";
import { denyMessage, needsApprovalMessage, noteMessage, outcomeOf } from "./common.js";
import { canonicalize } from "./tools.js";
import type { Adapter, FormatOptions, HookOutput } from "./types.js";

const GEMINI_EVENTS = new Set(["BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent", "BeforeModel", "AfterModel", "BeforeToolSelection", "PreCompress"]);

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export function detectGemini(input: Record<string, unknown>): boolean {
  return GEMINI_EVENTS.has(String(input.hook_event_name));
}

/** The text a tool returned: `{ llmContent, returnDisplay, error }`. */
function responseText(v: unknown): unknown {
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    return r.llmContent ?? r.returnDisplay ?? r.error ?? v;
  }
  return v ?? "";
}

export function parseGeminiInput(input: Record<string, unknown>, headless: boolean): ShieldEvent | null {
  const name = String(input.hook_event_name ?? "");
  const base = {
    agent: "gemini" as const,
    sessionId: text(input.session_id) ?? "unknown",
    cwd: text(input.cwd) ?? process.cwd(),
    headless,
    surface: name,
  };
  switch (name) {
    case "BeforeAgent":
      return { ...base, kind: "prompt", text: text(input.prompt) ?? "" };
    case "BeforeTool": {
      const c = canonicalize(String(input.tool_name ?? ""), input.tool_input);
      return { ...base, kind: "action", tool: c.tool, input: c.input, ...(c.rawTool ? { rawTool: c.rawTool } : {}) };
    }
    case "AfterTool": {
      const c = canonicalize(String(input.tool_name ?? ""), input.tool_input);
      return { ...base, kind: "result", tool: c.tool, input: c.input, output: responseText(input.tool_response), ...(c.rawTool ? { rawTool: c.rawTool } : {}) };
    }
    default:
      return null;
  }
}

export function formatGemini(decision: Decision, event: ShieldEvent, opts: FormatOptions = {}): HookOutput {
  const coach = opts.coach ?? "always";
  const outcome = outcomeOf(decision, event, false);
  if (event.kind !== "result") {
    if (outcome === "block") return { exitCode: 2, stderr: denyMessage(decision, event, coach) };
    if (outcome === "needs-approval" || outcome === "ask") return { exitCode: 2, stderr: needsApprovalMessage(decision, event, opts) };
    return { exitCode: 0 };
  }
  if (outcome === "note" && decision.findings.length > 0) {
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: noteMessage(decision, event, coach) } }) };
  }
  return { exitCode: 0 };
}

export const gemini: Adapter = {
  id: "gemini",
  detect: detectGemini,
  parse: parseGeminiInput,
  format: formatGemini,
};
