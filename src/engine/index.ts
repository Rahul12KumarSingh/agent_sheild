import type { Decision, ShieldEvent } from "./types.js";

export * from "./types.js";

/** P0 stub marker: proves a hook can deny in a real agent. Replaced by the rule engine in P1. */
export const TEST_MARKER = "AGENTSHIELD_TEST";

const ALLOW: Decision = { action: "allow", level: "CLEAN", score: 0, findings: [], reason: "" };

export function evaluate(event: ShieldEvent): Decision {
  const text = event.kind === "prompt" ? event.text : JSON.stringify(event.input);
  if (event.kind === "result" || !text.includes(TEST_MARKER)) return ALLOW;

  return {
    action: "block",
    level: "SEVERE",
    score: 100,
    findings: [
      {
        ruleId: "TEST-000",
        category: "SESSION",
        level: "SEVERE",
        confidence: 1,
        reason: `Contains the ${TEST_MARKER} marker`,
        excerpt: TEST_MARKER,
      },
    ],
    reason: `AgentShield test rule: anything containing ${TEST_MARKER} is blocked.`,
    safeAlternative: `Remove ${TEST_MARKER} and try again.`,
  };
}
