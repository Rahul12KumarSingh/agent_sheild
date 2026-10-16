import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HookOutput } from "../adapters/claude.js";

// `agentshield init`: add our hooks to Claude Code settings without touching anything else. Idempotent.

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

/** Forward slashes work on every OS and avoid JSON escaping surprises on Windows. */
export const cliPath = (fileUrlPath: string) => fileUrlPath.replace(/\\/g, "/");

export const isOurs = (h: Handler) => {
  const line = [h.command ?? "", ...(h.args ?? [])].join(" ");
  return /\bhook\s+claude\b/.test(line) && /agentshield|cli\.js/i.test(line);
};

export function ourHandler(cli: string): Handler {
  // Exec form: no shell, so paths with spaces need no quoting. onFailure "block" makes a crash or timeout deny (fail closed).
  return { type: "command", command: "node", args: [cli, "hook", "claude"], timeout: 30, onFailure: "block" };
}

/**
 * Where `init` keeps its own copy of the hook program. The CLI is one self-contained file, so hooks that
 * point here keep working after an npx cache cleanup, a global uninstall or a moved clone.
 */
export const runtimePath = (home = homedir()) => join(home, ".agentshield", "bin", "agentshield.mjs");

/** Copy this bundle to the runtime path when it changed, and return the path the hooks should run. */
export function installRuntime(cli: string, target = runtimePath()): string {
  if (cli !== target) {
    const next = readFileSync(cli);
    if (!existsSync(target) || !readFileSync(target).equals(next)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, next);
    }
  }
  return cliPath(target);
}

export function settingsPath(opts: { user: boolean; cwd: string; home?: string }): string {
  return opts.user ? join(opts.home ?? homedir(), ".claude", "settings.json") : join(opts.cwd, ".claude", "settings.json");
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  return raw ? (JSON.parse(raw) as Settings) : {};
}

/** Returns the new settings and a list of changes. Never removes other hooks. */
export function installClaude(settings: Settings, cli: string, remove = false): { settings: Settings; changes: string[] } {
  const next: Settings = structuredClone(settings);
  next.hooks ??= {};
  const changes: string[] = [];
  const handler = ourHandler(cli);

  for (const event of CLAUDE_EVENTS) {
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
      groups.push(event === "UserPromptSubmit" ? { hooks: [handler] } : { matcher: "*", hooks: [handler] });
      changes.push(`added ${event} hook`);
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changes };
}

export function initCommand(args: string[], opts: { cwd: string; cli: string; runtime?: string }): HookOutput {
  const user = args.includes("--user");
  const remove = args.includes("--remove");
  const agent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : "claude";
  if (agent !== "claude" && agent !== "copilot") return { exitCode: 1, stderr: `init supports --agent claude (default) and --agent copilot.` };
  // --in-place points the hooks at this very file (for working on AgentShield itself).
  let hookCli: string;
  try {
    hookCli = remove || args.includes("--in-place") ? cliPath(opts.cli) : installRuntime(opts.cli, opts.runtime);
  } catch (err) {
    return { exitCode: 1, stderr: `Could not copy the hook program to ${opts.runtime ?? runtimePath()}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (agent === "copilot") return initCopilot({ user, remove, cwd: opts.cwd, cli: hookCli });

  const path = settingsPath({ user, cwd: opts.cwd });
  let settings: Settings;
  try {
    settings = readSettings(path);
  } catch (err) {
    return { exitCode: 1, stderr: `${path} is not valid JSON, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { settings: next, changes } = installClaude(settings, hookCli, remove);
  if (changes.length === 0) return { exitCode: 0, stdout: `${path}: already ${remove ? "clean" : "up to date"}. Run \`agentshield doctor\` to check the setup.` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  const tail = remove
    ? "AgentShield hooks removed."
    : [
        `Hooks run ${hookCli}.`,
        "",
        "Next:",
        "  1. Restart Claude Code (or open /hooks) so it picks up the change.",
        "  2. npx agentshield-hooks doctor     check that everything is green",
        "  3. npx agentshield-hooks setup      settings page: rules in plain English, AI judge, test bench",
        "",
        "AI review is on: risky-looking commands (network, delete, database, cloud) and web pages the agent reads",
        "are also checked by AI, with secrets, your home folder and user name removed. Your prompts never leave.",
        "It can only make a decision stricter. Turn it off in setup, or add `ai_judge: off` to ~/.agentshield/config.yaml.",
      ].join("\n");
  return { exitCode: 0, stdout: `${path}:\n  ${changes.join("\n  ")}\n${tail}` };
}

// ---------- GitHub Copilot (CLI, cloud agent, VS Code) ----------

export const COPILOT_EVENTS = ["userPromptSubmitted", "preToolUse", "postToolUse"] as const;

/** One file of our own, so other hook files are never touched. `command` works in bash and PowerShell. */
export function copilotHooks(cli: string) {
  const entry = { type: "command", command: `node "${cli}" hook copilot`, timeoutSec: 30 };
  return { version: 1, hooks: Object.fromEntries(COPILOT_EVENTS.map((e) => [e, [entry]])) };
}

function initCopilot(o: { user: boolean; remove: boolean; cwd: string; cli: string; home?: string }): HookOutput {
  const dir = o.user ? join(o.home ?? homedir(), ".copilot", "hooks") : join(o.cwd, ".github", "hooks");
  const path = join(dir, "agentshield.json");
  if (o.remove) {
    if (!existsSync(path)) return { exitCode: 0, stdout: `${path}: nothing to remove.` };
    rmSync(path);
    return { exitCode: 0, stdout: `${path}: removed.` };
  }
  const next = `${JSON.stringify(copilotHooks(o.cli), null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === next) return { exitCode: 0, stdout: `${path}: already up to date.` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, next);
  return {
    exitCode: 0,
    stdout: `${path}: AgentShield hooks for userPromptSubmitted, preToolUse, postToolUse.\nCopilot can deny actions (fail closed on a crash) but cannot block prompts; prompts are recorded only.`,
  };
}
