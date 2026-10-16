import { describe, expect, it } from "vitest";
import { evaluate } from "../src/engine/index.js";
import { EVERYDAY_WORK } from "../src/server/rulecheck.js";
import { GUARDRAILS, mergePolicy, parseCustomRule, parsePolicyFile } from "../src/policy/index.js";
import { cmd, POSIX } from "./helpers.js";

describe("ready-made guardrails", () => {
  it("every rule passes the same validation as a developer's own rules", () => {
    for (const g of GUARDRAILS) for (const r of g.rules) expect(() => parseCustomRule(r, `${g.id}.${r.id}`)).not.toThrow();
  });

  it("each pack stops its own examples", () => {
    for (const g of GUARDRAILS) {
      for (const ex of g.examples) {
        const d = evaluate(cmd(ex), POSIX);
        expect(["block", "ask"], `${g.id}: ${ex} -> ${d.action}`).toContain(d.action);
      }
    }
  });

  it("never stops a day of normal work", () => {
    for (const text of EVERYDAY_WORK) {
      const d = evaluate(cmd(text), POSIX);
      expect(d.findings.filter((f) => f.ruleId.startsWith("GRD")).map((f) => f.reason), text).toEqual([]);
    }
  });

  it("can be switched off one pack at a time, and only to known ids", () => {
    const off = mergePolicy({ user: parsePolicyFile({ guardrails_off: ["publishing"] }) });
    expect(evaluate(cmd("npm publish"), POSIX, { policy: off }).findings.map((f) => f.ruleId)).not.toContain("GRD-002");
    expect(evaluate(cmd("terraform destroy"), POSIX, { policy: off }).action).toBe("block");
    expect(() => parsePolicyFile({ guardrails_off: ["everything"] })).toThrow(/expected one of/);
  });

  it("a company can lock them on", () => {
    const policy = mergePolicy({ company: { locked: ["guardrails_off"] }, user: parsePolicyFile({ guardrails_off: ["publishing"] }) });
    expect(policy.settings.guardrails_off).toEqual([]);
    expect(evaluate(cmd("npm publish"), POSIX, { policy }).findings.map((f) => f.ruleId)).toContain("GRD-002");
  });

  it("says it was a guardrail in the message", () => {
    expect(evaluate(cmd("gh auth token"), POSIX).reason).toContain('guardrail "Printing credentials"');
  });
});
