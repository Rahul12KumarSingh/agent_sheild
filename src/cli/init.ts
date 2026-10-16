import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function initCommand(args: string[], opts: { cwd: string; cli: string }): HookOutput {
  const user = args.includes("--user");
  const remove = args.includes("--remove");
  const agent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : "claude";
  if (agent !== "claude") return { exitCode: 1, stderr: `init supports: claude. For Copilot, see the README (Copilot hooks).` };

  const path = settingsPath({ user, cwd: opts.cwd });
  let settings: Settings;
  try {
    settings = readSettings(path);
  } catch (err) {
    return { exitCode: 1, stderr: `${path} is not valid JSON, nothing changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { settings: next, changes } = installClaude(settings, cliPath(opts.cli), remove);
  if (changes.length === 0) return { exitCode: 0, stdout: `${path}: already ${remove ? "clean" : "up to date"}. Run \`agentshield doctor\` to check the setup.` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  const tail = remove
    ? "AgentShield hooks removed."
    : "Restart Claude Code (or open /hooks) so it picks up the change, then run `agentshield doctor`.";
  return { exitCode: 0, stdout: `${path}:\n  ${changes.join("\n  ")}\n${tail}` };
}
