import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HookOutput } from "../adapters/types.js";

// `agentshield init`: add our hooks to an agent app's settings without touching anything else. Idempotent.
// Every entry is ONE shell string (`node "<cli>" hook <agent>`), never Claude Code's exec form (command + args):
// Copilot CLI, Cursor and VS Code also read .claude/settings.json and only understand `command`. Given just `node`,
// they would feed the hook message to Node as a script, exit 1, and (Copilot CLI) deny every tool call as "hook errored".

export const AGENT_NAMES = ["claude", "copilot", "cursor", "windsurf", "gemini"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Forward slashes work on every OS and avoid JSON escaping surprises on Windows. */
export const cliPath = (fileUrlPath: string) => fileUrlPath.replace(/\\/g, "/");

export const hookCommand = (cli: string, agent: string) => `node "${cli}" hook ${agent}`;

/** Is this command line ours (any agent, any path)? Also recognises the old exec form (`node` + args). */
export const isOurCommand = (line: string) => /\bhook\s+(?:claude|copilot|cursor|windsurf|gemini|auto)\b/.test(line) && /agentshield|cli\.js/i.test(line);

// ---------- Claude Code and Gemini CLI: groups of handlers per event ----------

export const CLAUDE_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;

interface Handler {
  type: string;
  command?: string;
  args?: string[];
  [k: string]: unknown;
}
interface Group {
  matcher?: string;
  hooks?: Handler[];
  [k: string]: unknown;
}
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

export const isOurs = (h: Handler) => isOurCommand([h.command ?? "", ...(h.args ?? [])].join(" "));

export function ourHandler(cli: string): Handler {
  // onFailure "block" (Claude Code 2.1.295+) makes a crash or timeout deny; other apps ignore the field.
  return { type: "command", command: hookCommand(cli, "claude"), timeout: 30, onFailure: "block" };
}

export function geminiHandler(cli: string): Handler {
  return { type: "command", command: hookCommand(cli, "gemini"), name: "agentshield", timeout: 30000 };
}

/** Returns the new settings and a list of changes. Never removes other hooks. */
function installGroups(settings: Settings, plan: { event: string; matcher?: string }[], handler: Handler, remove: boolean): { settings: Settings; changes: string[] } {
  const next: Settings = structuredClone(settings);
  next.hooks ??= {};
  const changes: string[] = [];

  for (const { event, matcher } of plan) {
    const groups = (next.hooks[event] ??= []);
    let found = false;
    for (const group of groups) {
      const before = group.hooks?.length ?? 0;
      if (remove) {
        group.hooks = (group.hooks ?? []).filter((h) => !isOurs(h));
        if ((group.hooks.length ?? 0) < before) changes.push(`removed ${event} hook`);
        continue;
      }
      for (const [i, h] of (group.hooks ?? []).entries()) {
        if (!isOurs(h)) continue;
        found = true;
        if (JSON.stringify(h) !== JSON.stringify(handler)) {
          group.hooks![i] = handler;
          changes.push(`updated ${event} hook`);
        }
      }
    }
    if (remove) {
      next.hooks[event] = groups.filter((g) => (g.hooks?.length ?? 0) > 0);
      if (next.hooks[event]!.length === 0) delete next.hooks[event];
      continue;
    }
    if (!found) {
      groups.push(matcher === undefined ? { hooks: [handler] } : { matcher, hooks: [handler] });
      changes.push(`added ${event} hook`);
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changes };
}

const CLAUDE_PLAN = CLAUDE_EVENTS.map((event) => ({ event, ...(event === "UserPromptSubmit" ? {} : { matcher: "*" }) }));
const GEMINI_PLAN = [{ event: "BeforeAgent" }, { event: "BeforeTool", matcher: ".*" }, { event: "AfterTool", matcher: ".*" }];

export const installClaude = (settings: Settings, cli: string, remove = false) => installGroups(settings, CLAUDE_PLAN, ourHandler(cli), remove);
export const installGemini = (settings: Settings, cli: string, remove = false) => installGroups(settings, GEMINI_PLAN, geminiHandler(cli), remove);

// ---------- Cursor and Windsurf: one flat entry per event ----------

interface FlatEntry {
  command?: string;
  matcher?: string;
  [k: string]: unknown;
}
type FlatFile = { version?: number; hooks?: Record<string, FlatEntry[]>; [k: string]: unknown };

/** Cursor can fail closed per hook. Shell, MCP and file writes do (they can change things); reads and prompts do not. */
export const CURSOR_PLAN: { event: string; matcher?: string; failClosed: boolean }[] = [
  { event: "beforeSubmitPrompt", failClosed: false },
  { event: "beforeShellExecution", failClosed: true },
  { event: "beforeMCPExecution", failClosed: true },
  { event: "beforeReadFile", failClosed: false },
  { event: "preToolUse", matcher: "Write|Delete", failClosed: true },
  { event: "postToolUse", failClosed: false },
];

export const WINDSURF_EVENTS = ["pre_user_prompt", "pre_run_command", "pre_read_code", "pre_write_code", "pre_mcp_tool_use", "post_run_command", "post_write_code", "post_mcp_tool_use"] as const;

function installFlat(file: FlatFile, entries: { event: string; entry: FlatEntry }[], remove: boolean): { file: FlatFile; changes: string[] } {
  const next: FlatFile = structuredClone(file);
  next.hooks ??= {};
  const changes: string[] = [];
  for (const { event, entry } of entries) {
    const list: FlatEntry[] = (next.hooks[event] ??= []);
    const at = list.findIndex((e) => isOurCommand(e.command ?? ""));
    if (remove) {
      if (at >= 0) {
        list.splice(at, 1);
        changes.push(`removed ${event} hook`);
      }
      if (list.length === 0) delete next.hooks[event];
      continue;
    }
    if (at < 0) {
      list.push(entry);
      changes.push(`added ${event} hook`);
    } else if (JSON.stringify(list[at]) !== JSON.stringify(entry)) {
      list[at] = entry;
      changes.push(`updated ${event} hook`);
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { file: next, changes };
}

export function installCursor(file: FlatFile, cli: string, remove = false) {
  const base: FlatFile = { version: 1, ...file };
  return installFlat(
    base,
    CURSOR_PLAN.map((p) => ({ event: p.event, entry: { command: hookCommand(cli, "cursor"), timeout: 30, failClosed: p.failClosed, ...(p.matcher ? { matcher: p.matcher } : {}) } })),
    remove,
  );
}

export function installWindsurf(file: FlatFile, cli: string, remove = false) {
  const command = hookCommand(cli, "windsurf");
  return installFlat(file, WINDSURF_EVENTS.map((event) => ({ event, entry: { command, powershell: command, show_output: false } })), remove);
}

// ---------- GitHub Copilot (CLI, cloud agent, VS Code): one file of our own ----------

export const COPILOT_EVENTS = ["userPromptSubmitted", "preToolUse", "postToolUse"] as const;

/** `command` works in bash and PowerShell. */
export function copilotHooks(cli: string) {
  const entry = { type: "command", command: hookCommand(cli, "copilot"), timeoutSec: 30 };
  return { version: 1, hooks: Object.fromEntries(COPILOT_EVENTS.map((e) => [e, [entry]])) };
}

// ---------- Files ----------

export interface InitOptions {
  cwd: string;
  cli: string;
  home?: string;
}

interface Target {
  path: string;
  /** Pure change of the parsed file. `undefined` for Copilot, which owns its whole file. */
  apply?: (data: Record<string, unknown>, cli: string, remove: boolean) => { data: Record<string, unknown>; changes: string[] };
}

export function targetFor(agent: AgentName, o: { user: boolean; cwd: string; home?: string }): Target {
  const home = o.home ?? homedir();
  const root = o.user ? home : o.cwd;
  switch (agent) {
    case "claude":
      return { path: join(root, ".claude", "settings.json"), apply: (d, c, r) => { const x = installClaude(d as Settings, c, r); return { data: x.settings, changes: x.changes }; } };
    case "gemini":
      return { path: join(root, ".gemini", "settings.json"), apply: (d, c, r) => { const x = installGemini(d as Settings, c, r); return { data: x.settings, changes: x.changes }; } };
    case "cursor":
      return { path: join(root, ".cursor", "hooks.json"), apply: (d, c, r) => { const x = installCursor(d as FlatFile, c, r); return { data: x.file, changes: x.changes }; } };
    case "windsurf": {
      // Devin Desktop reads .devin/hooks.json first; the older .windsurf/hooks.json only when that has no hooks.
      const path = o.user
        ? join(home, ".codeium", "windsurf", "hooks.json")
        : existsSync(join(o.cwd, ".devin", "hooks.json")) ? join(o.cwd, ".devin", "hooks.json") : join(o.cwd, ".windsurf", "hooks.json");
      return { path, apply: (d, c, r) => { const x = installWindsurf(d as FlatFile, c, r); return { data: x.file, changes: x.changes }; } };
    }
    case "copilot":
      return { path: o.user ? join(home, ".copilot", "hooks", "agentshield.json") : join(o.cwd, ".github", "hooks", "agentshield.json") };
  }
}

/** Kept for the doctor and older callers: Claude Code's settings file. */
export const settingsPath = (opts: { user: boolean; cwd: string; home?: string }) => targetFor("claude", opts).path;

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  return raw ? (JSON.parse(raw) as Settings) : {};
}

const RESTART: Record<AgentName, string> = {
  claude: "Restart Claude Code (or open /hooks) so it picks up the change, then run `agentshield doctor`.",
  copilot: "Copilot CLI and cloud agent read .github/hooks; VS Code needs chat.useHooks (on by default). Prompts are recorded only: Copilot cannot block them.",
  cursor: "Cursor reloads hooks.json on save (check the Hooks output channel). Cursor cannot ask on file reads, so those asks become a deny with the approval command.",
  windsurf: "Restart Windsurf (Devin Desktop). Windsurf hooks cannot ask, so asks become a deny with the approval command.",
  gemini: "Restart Gemini CLI. Gemini hooks cannot ask, so asks become a deny with the approval command.",
};

function initOne(agent: AgentName, o: { user: boolean; remove: boolean; cwd: string; cli: string; home?: string }): HookOutput {
  const target = targetFor(agent, o);
  const path = target.path;

  if (!target.apply) {
    // Copilot: a file of our own, so other hook files are never touched.
    if (o.remove) {
      if (!existsSync(path)) return { exitCode: 0, stdout: `${path}: nothing to remove.` };
      rmSync(path);
      return { exitCode: 0, stdout: `${path}: removed.` };
    }
    const next = `${JSON.stringify(copilotHooks(o.cli), null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, "utf8") === next) return { exitCode: 0, stdout: `${path}: already up to date.` };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    return { exitCode: 0, stdout: `${path}: AgentShield hooks for userPromptSubmitted, preToolUse, postToolUse.\n${RESTART.copilot}` };
  }

  let data: Record<string, unknown>;
  try {
    data = readSettings(path) as Record<string, unknown>;
  } catch (err) {
    return { exitCode: 1, stderr: `${path} is not valid JSON, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { data: next, changes } = target.apply(data, o.cli, o.remove);
  if (changes.length === 0) return { exitCode: 0, stdout: `${path}: already ${o.remove ? "clean" : "up to date"}.` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { exitCode: 0, stdout: `${path}:\n  ${changes.join("\n  ")}\n${o.remove ? "AgentShield hooks removed." : RESTART[agent]}` };
}

export function initCommand(args: string[], opts: InitOptions): HookOutput {
  const user = args.includes("--user");
  const remove = args.includes("--remove");
  const wanted = args.includes("--agent") ? (args[args.indexOf("--agent") + 1] ?? "") : "claude";
  const names = wanted === "all" ? [...AGENT_NAMES] : AGENT_NAMES.filter((n) => n === wanted);
  if (names.length === 0) return { exitCode: 1, stderr: `init supports --agent ${AGENT_NAMES.join("|")}|all (default claude).` };

  const cli = cliPath(opts.cli);
  const out: string[] = [];
  let exitCode = 0;
  for (const agent of names) {
    const r = initOne(agent, { user, remove, cwd: opts.cwd, cli, home: opts.home });
    exitCode = Math.max(exitCode, r.exitCode);
    out.push(r.exitCode === 0 ? (r.stdout ?? "") : (r.stderr ?? ""));
  }
  if (!remove && names.includes("copilot") && names.includes("claude")) {
    out.push("Note: Copilot CLI also reads .claude/settings.json. If both files are present, a repeated event is counted once.");
  }
  if (!remove) out.push("Check it works: `agentshield doctor` runs every hook command the way the agent app does.");
  const text = out.join("\n");
  return exitCode ? { exitCode, stderr: text } : { exitCode, stdout: text };
}
