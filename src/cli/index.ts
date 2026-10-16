import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HookOutput } from "../adapters/claude.js";
import { evaluate } from "../engine/index.js";
import { runHook } from "../hook/run.js";
import { loadPolicyAsync } from "../policy/index.js";
import { configCommand } from "./config.js";
import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";

const VERSION = "0.9.0";
const CLI = fileURLToPath(import.meta.url);

const USAGE = `agentshield ${VERSION}: a policy checkpoint for AI coding agents

Usage:
  agentshield init [--user] [--remove]   Add the hooks to Claude Code (.claude/settings.json, or ~/.claude with --user)
  agentshield doctor                     Check the setup: hooks, policy, session folder, Claude Code, console
  agentshield check [--json] [--profile <name>] <text>
                                         Score a prompt or command, print level, rules, reason and safe alternative
  agentshield config show|explain|set|path
                                         Read or change settings. Company rules cannot be loosened
  agentshield serve [--port 8080]        Run the console locally
  agentshield hook <agent> [--capture <dir>]
                                         Called by the agent app's hooks (JSON on stdin). Agents: claude
  agentshield --version
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Score the text both as a shell command and as a prompt, and report the stricter result. */
async function runCheck(args: string[]): Promise<HookOutput> {
  const json = args.includes("--json");
  const profile = flag(args, "--profile");
  const text = args.filter((a, i) => a !== "--json" && a !== "--profile" && args[i - 1] !== "--profile").join(" ");
  if (!text) return { exitCode: 1, stderr: USAGE };
  let policy;
  try {
    policy = await loadPolicyAsync({ cwd: process.cwd(), env: profile ? { ...process.env, AGENTSHIELD_PROFILE: profile } : process.env });
  } catch (err) {
    return { exitCode: 1, stderr: `AgentShield policy could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
  const base = { agent: "scripted" as const, sessionId: "check", cwd: process.cwd(), headless: false };
  const asCommand = evaluate({ ...base, kind: "action", tool: "Bash", input: { command: text } }, undefined, { policy });
  const asPrompt = evaluate({ ...base, kind: "prompt", text }, undefined, { policy });
  // On a tie prefer the prompt view: it carries the safer rewrite.
  const [as, decision] = asPrompt.score > 0 && asPrompt.score >= asCommand.score ? ["prompt", asPrompt] : ["command", asCommand];

  if (json) return { exitCode: 0, stdout: JSON.stringify({ as, profile: policy.profile, ...decision }, null, 2) };
  const lines = [`${decision.level} (score ${decision.score}) as a ${as}: ${decision.action.toUpperCase()}${decision.monitored ? ` (monitor mode, would ${decision.monitored})` : ""}   [profile ${policy.profile}]`];
  for (const f of decision.findings) lines.push(`  ${f.ruleId} [${f.category} ${f.level}] ${f.reason}`);
  if (decision.safeAlternative && decision.level !== "CLEAN") lines.push(`${as === "prompt" ? "Safer prompt" : "Safe alternative"}: ${decision.safeAlternative}`);
  return { exitCode: 0, stdout: lines.join("\n") };
}

async function serve(args: string[]): Promise<HookOutput> {
  const port = flag(args, "--port");
  if (port) process.env.PORT = port;
  // The server is a sibling bundle; a computed path keeps it out of the hook's bundle.
  await import(pathToFileURL(join(dirname(CLI), "server.js")).href);
  return { exitCode: 0 };
}

async function main(argv: string[]): Promise<HookOutput> {
  const [command, ...rest] = argv;
  switch (command) {
    case "hook": {
      const agent = rest[0] ?? "";
      const run = await runHook({ agent, raw: await readStdin(), captureDir: flag(rest, "--capture") ?? process.env.AGENTSHIELD_CAPTURE_DIR });
      return run.output;
    }
    case "check":
      return runCheck(rest);
    case "config":
      return configCommand(rest, { cwd: process.cwd(), env: process.env });
    case "init":
      return initCommand(rest, { cwd: process.cwd(), cli: CLI });
    case "doctor":
      return doctorCommand({ cwd: process.cwd(), env: process.env, cli: CLI });
    case "serve":
      return serve(rest);
    case "--version":
    case "-v":
      return { exitCode: 0, stdout: VERSION };
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: USAGE };
    default:
      return { exitCode: 1, stderr: `Unknown command: ${command}\n\n${USAGE}` };
  }
}

const out = await main(process.argv.slice(2));
if (out.stdout) process.stdout.write(out.stdout.endsWith("\n") ? out.stdout : `${out.stdout}\n`);
if (out.stderr) process.stderr.write(out.stderr.endsWith("\n") ? out.stderr : `${out.stderr}\n`);
process.exitCode = out.exitCode;
