import { evaluate } from "../engine/index.js";
import type { Decision } from "../engine/types.js";
import type { EffectivePolicy } from "../policy/index.js";
import type { CustomRule } from "../policy/rules.js";

// Before anyone saves a rule: run it through the real engine on its own examples and on a day of
// normal work, so "this rule would also stop npm test" is visible up front.

/** Everyday work a rule must not stop. Commands, plus file actions written the way the examples are. */
export const EVERYDAY_WORK = [
  "npm test", "npm run build", "npm install", "npx tsc --noEmit", "pnpm install", "yarn test",
  "python -m pytest -q", "pip install -r requirements.txt", "go test ./...", "cargo build", "make",
  "git status", "git diff", "git add -A", 'git commit -m "fix login bug"', "git pull", "git push origin feature/login",
  "git checkout -b feature/report", "git log --oneline -5",
  "ls -la", "cat README.md", "cat src/index.ts", "grep -rn TODO src", "mkdir -p src/utils", "rm -rf node_modules", "rm -rf dist",
  "docker build -t app .", "docker compose up -d", "curl http://localhost:3000/health", "curl https://api.github.com/repos/nodejs/node",
  "node scripts/seed.js", "code .", "cp .env.example .env",
  "edit src/app.ts", "edit README.md", "write tests/login.test.ts", "read package.json", "read docs/setup.md",
];

export interface CheckResult {
  text: string;
  expect: "stop" | "allow";
  got: Decision["action"];
  /** The rule ids from the draft that fired. */
  rules: string[];
  ok: boolean;
}

export interface DraftCheck {
  examples: CheckResult[];
  /** Everyday commands the draft would stop: a sign the rule is too broad. */
  overbroad: { text: string; rules: string[] }[];
}

const asEvent = (text: string, cwd: string) => {
  const m = /^(edit|write|read)\s+(\S+)$/i.exec(text.trim());
  if (m) {
    const tool = m[1]!.toLowerCase() === "read" ? "Read" : "Write";
    return { agent: "scripted" as const, sessionId: "rulecheck", cwd, headless: false, kind: "action" as const, tool, input: { file_path: m[2]!, content: "x" } };
  }
  return { agent: "scripted" as const, sessionId: "rulecheck", cwd, headless: false, kind: "action" as const, tool: "Bash", input: { command: text } };
};

export function withRules(policy: EffectivePolicy, rules: CustomRule[], source = "draft"): EffectivePolicy {
  return { ...policy, customRules: [...policy.customRules, ...rules.map((r) => ({ ...r, source }))] };
}

export function checkDraft(rules: CustomRule[], examples: { stop: string[]; allow: string[] }, base: EffectivePolicy, engine: { cwd: string; home: string; tmpDirs: string[] }): DraftCheck {
  // Only the draft rules: the question is what *they* do, not what the built-in rules already do.
  const policy: EffectivePolicy = { ...base, customRules: rules.map((r) => ({ ...r, source: "draft" })) };
  const ids = new Set(rules.map((r) => r.id));
  const fired = (text: string) => {
    const d = evaluate(asEvent(text, engine.cwd), { home: engine.home, tmpDirs: engine.tmpDirs }, { policy });
    const hits = d.findings.filter((f) => f.ruleId.startsWith("CUS-")).map((f) => /rule "([^"]+)"/.exec(f.reason)?.[1] ?? "").filter((id) => ids.has(id));
    return { d, hits };
  };
  const out: CheckResult[] = [];
  for (const [expect, list] of [["stop", examples.stop], ["allow", examples.allow]] as const) {
    for (const text of list.slice(0, 6)) {
      const { d, hits } = fired(text);
      out.push({ text, expect, got: d.action, rules: hits, ok: expect === "stop" ? hits.length > 0 : hits.length === 0 });
    }
  }
  const overbroad = EVERYDAY_WORK.map((text) => ({ text, rules: fired(text).hits })).filter((x) => x.rules.length > 0);
  return { examples: out, overbroad };
}
