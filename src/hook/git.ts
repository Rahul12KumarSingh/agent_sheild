import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GitGate } from "../engine/index.js";

// The changes a git command is about to commit or publish, for the engine's commit checks.
// Only called for `git commit`, `git push` and `gh pr create`. Never throws; no git, no repository or a timeout means "no diff".

const MAX_BYTES = 1_500_000;
const UNTRACKED_FILES = 30;
const UNTRACKED_MAX = 200_000;

function git(cwd: string, args: string[], okStatus = [0]): string | undefined {
  // Looking at a change must never run code from the repository's own config (fsmonitor, textconv, external diff).
  const safe = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args];
  const r = spawnSync("git", safe, { cwd, encoding: "utf8", timeout: 2500, maxBuffer: MAX_BYTES + 4096, windowsHide: true });
  if (r.error || r.status === null || !okStatus.includes(r.status)) return undefined;
  return r.stdout.length > MAX_BYTES ? r.stdout.slice(0, MAX_BYTES) : r.stdout;
}

const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "--diff-filter=ACMR"];

function untracked(cwd: string): string {
  const list = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!list) return "";
  const parts: string[] = [];
  for (const file of list.split("\0").filter(Boolean).slice(0, UNTRACKED_FILES)) {
    try {
      const path = join(cwd, file);
      if (statSync(path).size > UNTRACKED_MAX) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("\0")) continue; // binary
      const lines = text.split("\n");
      // The same shape `git diff` would give a new file, built here: one git process less per file.
      parts.push([`diff --git a/${file} b/${file}`, "new file mode 100644", "--- /dev/null", `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"));
    } catch {
      /* unreadable: skip */
    }
  }
  return parts.join("\n");
}

export function gitDiffSupplier(cwd: string): (gate: GitGate) => string | undefined {
  return (gate) => {
    try {
      if (gate === "staged") return git(cwd, [...DIFF, "--cached"]);
      if (gate === "worktree") {
        const tracked = git(cwd, [...DIFF, "HEAD"]) ?? git(cwd, [...DIFF, "--cached"]) ?? "";
        return `${tracked}\n${untracked(cwd)}`;
      }
      // Unpushed commits: against the upstream branch, else the usual default branches.
      for (const base of ["@{upstream}", "origin/HEAD", "origin/main", "origin/master"]) {
        const d = git(cwd, [...DIFF, `${base}...HEAD`]);
        if (d !== undefined) return d;
      }
    } catch {
      /* no diff is not a reason to deny */
    }
    return undefined;
  };
}
