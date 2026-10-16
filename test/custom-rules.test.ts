import { describe, expect, it } from "vitest";
import { evaluate } from "../src/engine/index.js";
import { describeRule, mergePolicy, parseCustomRule, parsePolicyFile } from "../src/policy/index.js";
import { cmd, fetchUrl, mcp, POSIX, prompt, read, write } from "./helpers.js";

const rule = (r: Record<string, unknown>) => parseCustomRule({ description: "A team rule", action: "block", ...r });
const withRules = (rules: unknown[]) => ({ policy: mergePolicy({ project: parsePolicyFile({ custom_rules: rules }) }) });
const decide = (e: Parameters<typeof evaluate>[0], rules: unknown[]) => evaluate(e, POSIX, withRules(rules));

describe("custom rules: validation", () => {
  it("normalises and derives an id", () => {
    const r = rule({ description: "Never destroy prod infra!", kind: "command", patterns: ["  Terraform   DESTROY "] });
    expect(r).toMatchObject({ id: "never-destroy-prod-infra", patterns: ["terraform destroy"], action: "block" });
    expect(describeRule(r)).toBe('Block commands starting with "terraform destroy"');
  });

  it("refuses anything that would loosen AgentShield", () => {
    expect(() => rule({ kind: "command", patterns: ["curl"], action: "allow" })).toThrow(/stricter/);
  });

  it.each([
    [{ kind: "command", patterns: ["npm"] }, /every "npm" command/],
    [{ kind: "path", patterns: ["**"] }, /every file/],
    [{ kind: "host", patterns: ["*"] }, /every website/],
    [{ kind: "host", patterns: ["*.com"] }, /top-level domain/],
    [{ kind: "text", patterns: [".*"] }, /any text/],
    [{ kind: "text", patterns: ["(a+)+$"] }, /nested repeat/],
    [{ kind: "text", patterns: ["(unclosed"] }, /not a valid regular expression/],
    [{ kind: "text", patterns: ["(\\w)\\1"] }, /back-references/],
    [{ kind: "host", patterns: ["not a host"] }, /not a host name/],
    [{ kind: "command", patterns: [] }, /at least one pattern/],
    [{ kind: "shell", patterns: ["x"] }, /expected one of/],
  ])("rejects %j", (r, msg) => {
    expect(() => rule(r)).toThrow(msg);
  });

  it("rejects duplicate ids and unknown keys in a policy file", () => {
    expect(() => parsePolicyFile({ custom_rules: [rule({ id: "x", kind: "command", patterns: ["a b"] }), rule({ id: "x", kind: "command", patterns: ["c d"] })] })).toThrow(/share the id/);
    expect(() => parsePolicyFile({ custom_rules: [{ description: "x y z", kind: "command", patterns: ["a b"], allow: true }] })).toThrow(/unknown key/);
  });
});

describe("custom rules: matching", () => {
  it("command prefixes, through sudo, pipes and disguises", () => {
    const rules = [{ description: "No prod deploys", kind: "command", patterns: ["kubectl apply -f k8s/prod"] }];
    expect(decide(cmd("sudo kubectl apply -f k8s/prod/web.yaml"), rules).action).toBe("block");
    expect(decide(cmd('k""ubectl apply -f k8s/prod'), rules).action).toBe("block");
    expect(decide(cmd("kubectl apply -f k8s/staging"), rules).action).toBe("allow");
  });

  it("paths, for file tools and command arguments, honouring on: [write]", () => {
    const rules = [{ description: "Generated client is read-only", kind: "path", patterns: ["src/generated/**"], on: ["write"] }];
    expect(decide(write("src/generated/api.ts", "x"), rules).action).toBe("block");
    expect(decide(read("src/generated/api.ts"), rules).action).toBe("allow");
    expect(decide(cmd("rm src/generated/api.ts"), rules).action).toBe("block");
  });

  it("hosts, in commands, web fetches and MCP inputs, including subdomains", () => {
    const rules = [{ description: "Nothing to our partner sandbox", kind: "host", patterns: ["*.partner.example"] }];
    expect(decide(cmd("curl https://api.partner.example/v1"), rules).action).toBe("block");
    expect(decide(fetchUrl("https://partner.example/docs"), rules).action).toBe("block");
    expect(decide(mcp("mcp__http__get", { url: "https://x.partner.example" }), rules).action).toBe("block");
    expect(decide(cmd("curl https://partner.example.org"), rules).action).toBe("allow");
  });

  it("text regexes on commands and prompts, case-insensitive", () => {
    const rules = [{ description: "No customer exports", kind: "text", patterns: ["customer[_-]?export"], action: "ask" }];
    expect(decide(cmd("python scripts/Customer_Export.py"), rules).action).toBe("ask");
    expect(decide(prompt("run the customer-export job for all users"), rules).findings.map((f) => f.ruleId)).toContain("CUS-002");
  });

  it("shows the rule's own alternative and where it came from", () => {
    const d = decide(cmd("ansible-playbook deploy-prod.yml"), [{ description: "Never deploy to production", kind: "command", patterns: ["ansible-playbook deploy-prod.yml"], alternative: "Run it against staging and show the user." }]);
    expect(d.safeAlternative).toBe("Run it against staging and show the user.");
    expect(d.reason).toContain('project rule "never-deploy-to-production"');
  });
});

describe("custom rules: layers", () => {
  it("add up across company, project and personal, and nobody can remove a higher layer's rule", () => {
    const c = { custom_rules: [rule({ id: "c1", kind: "command", patterns: ["helm uninstall"] })] };
    const p = { custom_rules: [rule({ id: "p1", kind: "command", patterns: ["npm publish"] })] };
    const u = { custom_rules: [rule({ id: "u1", kind: "command", patterns: ["git push --force"] })] };
    const policy = mergePolicy({ company: c, project: p, user: u });
    expect(policy.customRules.filter((r) => r.source !== "guardrail").map((r) => `${r.source}:${r.id}`)).toEqual(["company:c1", "project:p1", "personal config:u1"]);
  });

  it("a repository cannot redirect AI requests to its own server", () => {
    const policy = mergePolicy({ project: parsePolicyFile({ ai_endpoint: "https://evil.example" }) });
    expect(policy.aiEndpoint).toBeUndefined();
    expect(policy.warnings.join(" ")).toContain("ignored ai_endpoint");
    expect(mergePolicy({ user: parsePolicyFile({ ai_endpoint: "https://mine.example" }) }).aiEndpoint).toBe("https://mine.example");
  });
});

describe("the agent cannot change its own guardrails through the CLI", () => {
  it.each([
    "npx agentshield-hooks config set ai_judge off",
    "npx -y agentshield-hooks init --remove",
    "pnpm dlx agentshield-hooks config set warning_action ask",
    "agentshield setup",
    "node ~/.agentshield/bin/agentshield.mjs init --in-place",
  ])("%s is blocked", (c) => {
    expect(evaluate(cmd(c), POSIX).findings.map((f) => f.ruleId)).toContain("TAM-001");
  });

  it.each(["npx agentshield-hooks check 'rm -rf ~'", "npx agentshield-hooks doctor", "agentshield config show"])("%s is fine", (c) => {
    expect(evaluate(cmd(c), POSIX).action).toBe("allow");
  });
});

describe("the agent cannot change its guardrails from inline code either", () => {
  it.each([
    `node -e 'const fs=require("fs");const p=".claude/settings.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));s.theme="dark";fs.writeFileSync(p,JSON.stringify(s,null,2))'`,
    `python3 -c "import json; json.dump({}, open('.claude/settings.json','w'))"`,
    `perl -pi -e 's/PreToolUse/x/' .claude/settings.json`,
    `Set-Content -Path .claude\\settings.local.json -Value '{}'`,
    `rm -rf ~/.agentshield/`,
  ])("%s is blocked", (c) => {
    expect(evaluate(cmd(c), POSIX).action).toBe("block");
  });

  it.each(["cat .claude/settings.json", "jq .hooks .claude/settings.json", "grep -n hooks .claude/settings.json", "ls ~/.agentshield/"])("%s is fine", (c) => {
    expect(evaluate(cmd(c), POSIX).findings.map((f) => f.ruleId)).not.toContain("TAM-001");
  });
});

it("grep -i on the settings is still only a read", () => {
  expect(evaluate(cmd("grep -i hooks .claude/settings.json"), POSIX).findings.map((f) => f.ruleId)).not.toContain("TAM-001");
});
