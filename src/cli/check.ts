import { evaluate } from "../engine/index.js";
import type { Decision } from "../engine/types.js";
import type { EffectivePolicy } from "../policy/index.js";

export type CheckAs = "prompt" | "command";

/** Score text the way the hook would: as a prompt, as a shell command, or (auto) whichever is stricter. */
export function checkText(text: string, policy: EffectivePolicy, cwd: string, mode: CheckAs | "auto" = "auto"): { as: CheckAs; decision: Decision } {
  const base = { agent: "scripted" as const, sessionId: "check", cwd, headless: false };
  const asCommand = mode !== "prompt" ? evaluate({ ...base, kind: "action", tool: "Bash", input: { command: text } }, undefined, { policy }) : undefined;
  const asPrompt = mode !== "command" ? evaluate({ ...base, kind: "prompt", text }, undefined, { policy }) : undefined;
  if (!asCommand) return { as: "prompt", decision: asPrompt! };
  if (!asPrompt) return { as: "command", decision: asCommand };
  // On a tie prefer the prompt view: it carries the safer rewrite.
  return asPrompt.score > 0 && asPrompt.score >= asCommand.score ? { as: "prompt", decision: asPrompt } : { as: "command", decision: asCommand };
}

export function describeCheck(as: CheckAs, d: Decision, profile: string): string {
  const lines = [`${d.level} (score ${d.score}) as a ${as}: ${d.action.toUpperCase()}${d.monitored ? ` (monitor mode, would ${d.monitored})` : ""}   [profile ${profile}]`];
  for (const f of d.findings) lines.push(`  ${f.ruleId} [${f.category} ${f.level}] ${f.reason}`);
  if (d.safeAlternative && d.level !== "CLEAN") lines.push(`${as === "prompt" ? "Safer prompt" : "Safe alternative"}: ${d.safeAlternative}`);
  return lines.join("\n");
}
