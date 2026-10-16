import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { newSession, type SessionState } from "../engine/index.js";

// One small JSON file per agent session, in a per-user folder. Written atomically, expires after 24 hours.

const DAY = 24 * 60 * 60 * 1000;

const sessionsDir = (stateDir: string) => join(stateDir, "sessions");
const fileFor = (stateDir: string, id: string) => join(sessionsDir(stateDir), `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`);

function read(file: string): SessionState | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    if (typeof s.blocks !== "number" || typeof s.legs !== "object" || !s.updatedAt) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

export function loadSession(stateDir: string, id: string, now = new Date()): SessionState {
  const s = read(fileFor(stateDir, id));
  if (!s || now.getTime() - Date.parse(s.updatedAt) > DAY) return newSession(id, now);
  return s;
}

/**
 * Agent apps can run hooks in parallel, so merge with whatever is on disk first:
 * legs only ever switch on and the block count only grows within a session.
 */
export function saveSession(stateDir: string, state: SessionState): void {
  const dir = sessionsDir(stateDir);
  const file = fileFor(stateDir, state.id);
  const fresh = !existsSync(file);
  mkdirSync(dir, { recursive: true });
  const disk = read(file);
  const merged: SessionState =
    disk && disk.createdAt === state.createdAt
      ? {
          ...state,
          legs: { A: state.legs.A ?? disk.legs.A, B: state.legs.B ?? disk.legs.B },
          blocks: Math.max(state.blocks, disk.blocks),
          ...(disk.scripts || state.scripts ? { scripts: { ...disk.scripts, ...state.scripts } } : {}),
        }
      : state;
  if (!merged.legs.A) delete merged.legs.A;
  if (!merged.legs.B) delete merged.legs.B;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      break;
    } catch (err) {
      // Windows: the target can be briefly locked by a parallel hook.
      if (attempt >= 4) {
        try {
          unlinkSync(tmp);
        } catch {}
        throw err;
      }
    }
  }
  if (fresh) sweep(dir);
}

function sweep(dir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (now - statSync(p).mtimeMs > DAY) unlinkSync(p);
    }
  } catch {}
}

/** The git remote URL for a name like "origin", from the repository's own config. */
export function gitRemoteUrl(cwd: string, name: string): string | undefined {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 25; i++) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const target = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
          if (!target) return undefined;
          gitDir = resolve(dir, target);
          const common = join(gitDir, "commondir");
          if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
        }
        const config = readFileSync(join(gitDir, "config"), "utf8");
        const section = new RegExp(`\\[remote\\s+"${name.replace(/[^\w.-]/g, "")}"\\]([^[]*)`).exec(config)?.[1] ?? "";
        return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim();
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {}
  return undefined;
}
