import { formatClaude, parseClaude, type HookOutput } from "../adapters/claude.js";
import { evaluate } from "../engine/index.js";
import { capturePayload } from "./capture.js";

const VERSION = "0.0.1";

const USAGE = `agentshield ${VERSION}

Usage:
  agentshield hook <agent> [--capture <dir>]
                                Called by the agent app's hooks (reads JSON on stdin). Agents: claude
                                --capture saves each raw payload (scrubbed) for test fixtures
  agentshield check <text> [--json]
                                Score text as a command and as a prompt, print the stricter decision
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

/** Score the text both as a shell command and as a prompt, and report the stricter result. */
function runCheck(args: string[]): HookOutput {
  const json = args.includes("--json");
  const text = args.filter((a) => a !== "--json").join(" ");
  const base = { agent: "scripted" as const, sessionId: "check", cwd: process.cwd(), headless: false };
  const asCommand = evaluate({ ...base, kind: "action", tool: "Bash", input: { command: text } });
  const asPrompt = evaluate({ ...base, kind: "prompt", text });
  // On a tie prefer the prompt view: it carries the safer rewrite.
  const [as, decision] = asPrompt.score > 0 && asPrompt.score >= asCommand.score ? ["prompt", asPrompt] : ["command", asCommand];

  if (json) return { exitCode: 0, stdout: JSON.stringify({ as, ...decision }, null, 2) };
  const lines = [`${decision.level} (score ${decision.score}) as a ${as}: ${decision.action.toUpperCase()}`];
  for (const f of decision.findings) lines.push(`  ${f.ruleId} [${f.category} ${f.level}] ${f.reason}`);
  if (decision.safeAlternative) lines.push(`${as === "prompt" ? "Safer prompt" : "Safe alternative"}: ${decision.safeAlternative}`);
  return { exitCode: 0, stdout: lines.join("\n") };
}

async function main(argv: string[]): Promise<HookOutput> {
  const [command, ...rest] = argv;
  switch (command) {
    case "hook":
      return runHook(rest);
    case "check":
      if (rest.length === 0) return { exitCode: 1, stderr: USAGE };
      return runCheck(rest);
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
