import { clip, dedupe, hit } from "./catalog.js";
import { commandFindingsInContent } from "./commands.js";
import { findSecrets, injectionFindings, redactSecrets } from "./detectors.js";
import { isAutomationPath, isGuardrailPath, isInstructionPath, isSecretPath, type PathContext } from "./paths.js";
import type { Finding } from "./types.js";

// What is about to be committed or pushed. A poisoned pull request is mostly a change that looks small:
// a key in a config file, a line added to a CI workflow, a hook that runs on checkout, a hidden note for the next AI agent.
// The hook (not the engine) runs `git` to get the diff, so this file stays free of the file system.

interface FileChange {
  path: string;
  kind: "add" | "modify" | "delete";
  added: string[];
}

const MAX_FILES = 300;
const MAX_ADDED_PER_FILE = 100_000;

export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: m?.[2] ?? m?.[1] ?? "", kind: "modify", added: [] };
      if (files.length < MAX_FILES) files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.kind = "add";
    else if (line.startsWith("deleted file mode")) current.kind = "delete";
    else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target !== "/dev/null") current.path = target.replace(/^b\//, "");
    } else if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
  }
  return files.filter((f) => f.path);
}

const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|corpus|samples?|examples?)\//i;
const SCRIPTY = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|rb|pl|ya?ml)$/i;

/** The command inside a CI or build line: `- run: x`, `RUN x`, `"postinstall": "x"`, a plain `- x` list item. */
export function commandish(line: string): string {
  let l = line.trim();
  const json = /^"[^"]+"\s*:\s*"(.*)",?$/.exec(l);
  if (json) return json[1]!.replace(/\\"/g, '"');
  l = l.replace(/^(?:-\s+)?(?:run|script|command|cmd|entrypoint|args?|exec|shell)\s*:\s*/i, "").replace(/^-\s+/, "").replace(/^(?:RUN|CMD|ENTRYPOINT)\s+/, "");
  return l.replace(/^["']|["']$/g, "");
}

/** Findings for a diff of staged, working-tree or outgoing changes. */
export function analyzeDiff(diff: string, ctx: PathContext): Finding[] {
  const findings: Finding[] = [];
  for (const file of parseDiff(diff)) {
    if (file.kind === "delete") continue;
    const { path } = file;

    if (isSecretPath(path, ctx)) findings.push(hit("GIT-002", path, undefined, undefined, path));
    if (isGuardrailPath(path, ctx) || isInstructionPath(path, ctx)) findings.push(hit("GIT-003", path, undefined, undefined, path));

    const added = file.added.join("\n").slice(0, MAX_ADDED_PER_FILE);
    if (!added.trim()) continue;

    const secrets = findSecrets(added);
    if (secrets.length > 0) {
      const sample = file.added.find((l) => findSecrets(l).length > 0) ?? "";
      findings.push(hit("GIT-001", `${[...new Set(secrets.map((s) => s.type))].join(", ")} in ${path}`, clip(redactSecrets(sample)), undefined, path));
    }

    if (isAutomationPath(path, ctx) || SCRIPTY.test(path)) {
      const risky = commandFindingsInContent(file.added.map(commandish).join("\n").slice(0, MAX_ADDED_PER_FILE), ctx);
      if (risky.length > 0) {
        const top = risky.reduce((a, b) => (b.level === "SEVERE" && a.level !== "SEVERE" ? b : a));
        findings.push(hit("GIT-004", `${top.ruleId} in ${path}`, top.excerpt, undefined, path));
        // A line that sends secrets out or destroys things is not a judgement call: show the rule it breaks.
        for (const f of risky) {
          if (f.level === "SEVERE" && (f.category === "EXFIL" || f.category === "DESTROY")) findings.push({ ...f, reason: `${f.reason} (added to ${path})`, target: path });
        }
      }
    }

    const planted = injectionFindings(added).filter((f) => !(f.ruleId === "INJ-001" && TEST_PATH.test(path)));
    if (planted.length > 0) findings.push(hit("GIT-005", `${planted[0]!.ruleId} in ${path}`, undefined, undefined, path));
  }
  return dedupe(findings);
}
