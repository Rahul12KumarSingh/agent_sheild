import { createInterface } from "node:readline";
import { type EffectivePolicy, loadPolicyAsync } from "../policy/index.js";
import { type CheckAs, checkText, describeCheck } from "./check.js";

// `agentshield mcp`: a Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line).
// Advice only: an agent may call it, but nothing forces it to. Hooks remain the enforcement.

const TOOLS = [
  {
    name: "check_prompt",
    title: "Check a prompt",
    description: "Score a prompt with AgentShield before sending it: level, rules, reason, and a safer prompt with secrets replaced by placeholders.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The prompt to check" } }, required: ["text"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "check_command",
    title: "Check a shell command",
    description: "Score a shell command (Bash, PowerShell or cmd) with AgentShield before running it: level, rules, reason and a safe alternative. Nothing is executed.",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "The command to check" } }, required: ["command"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

type Json = Record<string, unknown>;
const reply = (id: unknown, result: Json) => JSON.stringify({ jsonrpc: "2.0", id, result });
const error = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function handleMcp(message: Json, ctx: { policy?: EffectivePolicy; policyError?: string; cwd: string; version: string }): string | undefined {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentshield", title: "AgentShield", version: ctx.version },
        instructions: "Call check_prompt before sending a prompt that may contain secrets or personal data, and check_command before running a command that deletes, uploads, or installs something. Follow the safe alternative when the level is WARNING or SEVERE.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const a = (params.arguments ?? {}) as Json;
      const text = name === "check_prompt" ? a.text : name === "check_command" ? a.command : undefined;
      if (name !== "check_prompt" && name !== "check_command") return error(id, -32602, `Unknown tool: ${String(name)}`);
      if (typeof text !== "string" || !text.trim()) return reply(id, { content: [{ type: "text", text: "Give a non-empty text to check." }], isError: true });
      if (!ctx.policy) return reply(id, { content: [{ type: "text", text: `AgentShield policy could not be loaded: ${ctx.policyError}. Treat this as a block.` }], isError: true });
      const as: CheckAs = name === "check_prompt" ? "prompt" : "command";
      const { decision } = checkText(text.slice(0, 100_000), ctx.policy, ctx.cwd, as);
      return reply(id, {
        content: [{ type: "text", text: describeCheck(as, decision, ctx.policy.profile) }],
        structuredContent: {
          level: decision.level,
          action: decision.action,
          score: decision.score,
          rules: decision.findings.map((f) => f.ruleId),
          reason: decision.reason,
          ...(decision.safeAlternative ? { safeAlternative: decision.safeAlternative } : {}),
        },
        isError: false,
      });
    }
    default:
      // Notifications (no id) get no answer.
      return isRequest ? error(id, -32601, `Method not found: ${String(method)}`) : undefined;
  }
}

export async function runMcp(opts: { cwd: string; env: NodeJS.ProcessEnv; version: string }): Promise<void> {
  let policy: EffectivePolicy | undefined;
  let policyError: string | undefined;
  try {
    policy = await loadPolicyAsync({ cwd: opts.cwd, env: opts.env });
  } catch (err) {
    policyError = err instanceof Error ? err.message : String(err);
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      process.stdout.write(`${error(null, -32700, "Parse error")}\n`);
      continue;
    }
    const out = handleMcp(message, { policy, policyError, cwd: opts.cwd, version: opts.version });
    if (out) process.stdout.write(`${out}\n`);
  }
}
