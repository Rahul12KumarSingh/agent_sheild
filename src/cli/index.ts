import { formatClaude, parseClaude, type HookOutput } from "../adapters/claude.js";
import { evaluate } from "../engine/index.js";
import { capturePayload } from "./capture.js";

const VERSION = "0.0.1";

const USAGE = `agentshield ${VERSION}

Usage:
  agentshield hook <agent> [--capture <dir>]
                                Called by the agent app's hooks (reads JSON on stdin). Agents: claude
                                --capture saves each raw payload (scrubbed) for test fixtures
  agentshield check <text>      Score a prompt or command and print the decision
  agentshield --version
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function isHeadless(): boolean {
  return process.env.AGENTSHIELD_HEADLESS === "1" || process.env.CI === "true";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runHook(args: string[]): Promise<HookOutput> {
  const agent = args[0];
  if (agent !== "claude") {
    return { exitCode: 2, stderr: `AgentShield: unsupported agent "${agent ?? ""}". Supported: claude` };
  }
  try {
    const raw = await readStdin();
    capturePayload(agent, raw, flag(args, "--capture") ?? process.env.AGENTSHIELD_CAPTURE_DIR);
    const event = parseClaude(raw, isHeadless());
    return formatClaude(evaluate(event), event);
  } catch (err) {
    // Fail closed: a broken shield denies with an explanation instead of letting the action through.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, stderr: `AgentShield internal error, action denied: ${message}` };
  }
}

function runCheck(text: string): HookOutput {
  const decision = evaluate({ agent: "scripted", kind: "prompt", sessionId: "check", cwd: process.cwd(), headless: false, text });
  return { exitCode: 0, stdout: JSON.stringify(decision, null, 2) };
}

async function main(argv: string[]): Promise<HookOutput> {
  const [command, ...rest] = argv;
  switch (command) {
    case "hook":
      return runHook(rest);
    case "check":
      if (rest.length === 0) return { exitCode: 1, stderr: USAGE };
      return runCheck(rest.join(" "));
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
