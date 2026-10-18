import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HookOutput } from "../adapters/types.js";
import { runHook } from "../hook/run.js";
import { loadPolicyAsync } from "../policy/index.js";
import { allowCommand, approvalsCommand } from "./allow.js";
import { checkText, describeCheck } from "./check.js";
import { configCommand } from "./config.js";
import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";
import { runMcp } from "./mcp.js";
import { demoCommand } from "./demo.js";
import { setupCommand } from "./setup.js";

const VERSION = "0.12.0";
const CLI = fileURLToPath(import.meta.url);

const USAGE = `agentshield ${VERSION}: a policy checkpoint for AI coding agents

Usage:
  agentshield init [--agent claude|copilot|cursor|windsurf|gemini|antigravity|all] [--user] [--remove] [--in-place]
                                         Add the hooks to an agent app's settings (project, or --user for every project).
                                         Hooks run a copy in ~/.agentshield/bin, so npx or a moved install keeps working;
                                         --in-place runs this file instead (for working on AgentShield itself)
  agentshield doctor                     Check the setup: runs every hook command the way the agent app does
  agentshield check [--json] [--profile <name>] <text>
                                         Score a prompt or command, print level, rules, reason and safe alternative
  agentshield allow "<command>"            Approve what AgentShield would ask about, for this project (a person's step)
  agentshield approvals [revoke <n|all>] List or remove saved approvals
  agentshield config show|explain|set|path
                                         Read or change settings. Company rules cannot be loosened
  agentshield setup [--port N] [--no-open]
                                         Settings page in your browser: rules in plain English, AI judge, test bench
  agentshield demo [folder]              A realistic demo project (fake secrets) and the prompts to try
  agentshield serve [--port 8080]        Run the console locally
  agentshield mcp                        MCP server (stdio) with check_prompt and check_command, advice only
  agentshield hook <agent> [--capture <dir>]
                                         Called by the agent app's hooks (JSON on stdin). The message decides the agent:
                                         claude, copilot (CLI, cloud agent, VS Code), cursor, windsurf, gemini, antigravity
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
  const { as, decision } = checkText(text, policy, process.cwd());
  if (json) return { exitCode: 0, stdout: JSON.stringify({ as, profile: policy.profile, ...decision }, null, 2) };
  return { exitCode: 0, stdout: describeCheck(as, decision, policy.profile) };
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
      const run = await runHook({ agent, raw: await readStdin(), captureDir: flag(rest, "--capture") ?? process.env.AGENTSHIELD_CAPTURE_DIR, event: flag(rest, "--event"), ai: "auto" });
      return run.output;
    }
    case "check":
      return runCheck(rest);
    case "allow":
      return allowCommand(rest, { cwd: process.cwd(), env: process.env });
    case "approvals":
      return approvalsCommand(rest, { cwd: process.cwd(), env: process.env });
    case "config":
      return configCommand(rest, { cwd: process.cwd(), env: process.env });
    case "init":
      return initCommand(rest, { cwd: process.cwd(), cli: CLI });
    case "doctor":
      return doctorCommand({ cwd: process.cwd(), env: process.env, cli: CLI });
    case "serve":
      return serve(rest);
    case "demo":
      return demoCommand(rest, { cwd: process.cwd(), cli: CLI });
    case "setup":
    case "settings":
    case "ui":
      return setupCommand(rest, CLI);
    case "mcp":
      await runMcp({ cwd: process.cwd(), env: process.env, version: VERSION });
      return { exitCode: 0 };
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
