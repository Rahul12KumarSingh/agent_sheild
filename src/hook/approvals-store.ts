import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ApprovedLookup } from "../engine/index.js";
import { normalizeTarget } from "../engine/index.js";

// Approvals that outlive a session: `agentshield allow` writes them, from a person's own terminal.
// They are kept per project and only ever turn an ask into a note. The agent cannot write this file
// (the folder is a guardrail path) and cannot run `agentshield allow` (that command is tamper).

export interface StoredApproval {
  rule: string;
  /** A resolved path, a command, or a pattern with `*` / `**`. */
  target: string;
  label?: string;
  at: string;
}

interface Store {
  version: 1;
  projects: Record<string, StoredApproval[]>;
}

const fileOf = (stateDir: string) => join(stateDir, "approvals.json");

/** The repository the working folder belongs to: the nearest folder with a `.git`, else the folder itself. */
export function projectKey(cwd: string): string {
  let dir = resolve(cwd);
  for (let i = 0; i < 25; i++) {
    if (existsSync(join(dir, ".git"))) return dir.replace(/\\/g, "/").toLowerCase();
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd).replace(/\\/g, "/").toLowerCase();
}

function read(stateDir: string): Store {
  try {
    const s = JSON.parse(readFileSync(fileOf(stateDir), "utf8")) as Store;
    if (s && s.version === 1 && s.projects && typeof s.projects === "object") return s;
  } catch {
    /* missing or damaged: start empty (a damaged file only means fewer approvals, never fewer protections) */
  }
  return { version: 1, projects: {} };
}

function write(stateDir: string, store: Store): void {
  mkdirSync(stateDir, { recursive: true });
  const file = fileOf(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
}

export function listApprovals(stateDir: string, cwd: string): StoredApproval[] {
  return read(stateDir).projects[projectKey(cwd)] ?? [];
}

export function addApproval(stateDir: string, cwd: string, rule: string, target: string, label?: string): StoredApproval {
  const store = read(stateDir);
  const key = projectKey(cwd);
  const list = (store.projects[key] ??= []);
  const wanted = normalizeTarget(target);
  const existing = list.find((a) => a.rule === rule && normalizeTarget(a.target) === wanted);
  if (existing) return existing;
  const entry: StoredApproval = { rule, target: wanted, ...(label ? { label: label.slice(0, 160) } : {}), at: new Date().toISOString() };
  list.push(entry);
  if (list.length > 500) list.splice(0, list.length - 500);
  write(stateDir, store);
  return entry;
}

/** Remove one approval by its number in the list (starting at 1), or all of them. Returns how many were removed. */
export function removeApprovals(stateDir: string, cwd: string, which: number | "all"): number {
  const store = read(stateDir);
  const key = projectKey(cwd);
  const list = store.projects[key] ?? [];
  const removed = which === "all" ? list.length : which >= 1 && which <= list.length ? 1 : 0;
  if (removed === 0) return 0;
  if (which === "all") delete store.projects[key];
  else list.splice(which - 1, 1);
  write(stateDir, store);
  return removed;
}

const globToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*")}$`,
  );

/** A lookup the engine can call for every ask: does a stored approval of this project cover (rule, target)? */
export function approvalLookup(stateDir: string, cwd: string): ApprovedLookup | undefined {
  if (!existsSync(fileOf(stateDir))) return undefined;
  const list = listApprovals(stateDir, cwd);
  if (list.length === 0) return undefined;
  return (rule, target) => {
    const t = normalizeTarget(target);
    return list.some((a) => a.rule === rule && (normalizeTarget(a.target) === t || (a.target.includes("*") && globToRegExp(normalizeTarget(a.target)).test(t))));
  };
}
