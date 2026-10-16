import type { Action, Finding, Level, ShieldEvent } from "./types.js";

// The transparent formula from the team guide: weight × confidence for the strongest finding,
// a little extra for each further finding, +15 when the command was disguised. Capped at 100.

const WEIGHT: Record<Finding["level"], number> = { SEVERE: 85, WARNING: 50, MILD: 20 };

export const findingWeight = (f: Finding) => WEIGHT[f.level] * f.confidence;

export function scoreOf(findings: Finding[], disguised: boolean): number {
  if (findings.length === 0) return 0;
  const top = Math.max(...findings.map(findingWeight));
  const extra = Math.min(10, (findings.length - 1) * 5);
  return Math.min(100, Math.round(top + extra + (disguised ? 15 : 0)));
}

export function levelOf(score: number): Level {
  if (score >= 70) return "SEVERE";
  if (score >= 35) return "WARNING";
  if (score >= 1) return "MILD";
  return "CLEAN";
}

/**
 * Prompts can be blocked but not "asked" about, and results have already happened,
 * so both can only be noted unless a prompt is SEVERE (or WARNING when the policy says block).
 */
export function actionFor(kind: ShieldEvent["kind"], level: Level, warningAction: "ask" | "block" = "ask"): Action {
  if (level === "CLEAN") return "allow";
  if (kind === "action") return level === "SEVERE" ? "block" : level === "WARNING" ? warningAction : "note";
  if (kind === "prompt") return level === "SEVERE" || (level === "WARNING" && warningAction === "block") ? "block" : "note";
  return "note";
}
