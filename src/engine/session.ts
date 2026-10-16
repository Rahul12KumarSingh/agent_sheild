import { findPII, findSecrets, filterPII } from "./detectors.js";
import {
  fetchesOutsideText,
  hostAllowed,
  type OutsideAction,
  outsideCommand,
  type OutsideOptions,
  parseSegments,
  urlHosts,
} from "./commands.js";
import { normalizeCommand } from "./normalize.js";
import { classifyPath, isThirdPartyPath, type PathContext, resolvePath } from "./paths.js";
import type { ActionEvent, Decision, Finding, ShieldEvent } from "./types.js";

// The Rule of Two: a session may hold at most two of
//   A  a stranger's text   B  sensitive data   C  an outside action
// A and B are remembered after they happen. C is checked before an action runs.

export interface Leg {
  at: string;
  why: string;
}

export interface FlaggedScript {
  why: string;
  /** The script sends data out or acts outside the project: running it is leg C. */
  outside: boolean;
}

export interface SessionState {
  id: string;
  legs: { A?: Leg; B?: Leg };
  /** Blocked actions so far, for the circuit breaker. */
  blocks: number;
  /** Scripts this session wrote with risky commands in them (staged payloads), by resolved path. */
  scripts?: Record<string, FlaggedScript>;
  createdAt: string;
  updatedAt: string;
}

export const newSession = (id: string, now = new Date()): SessionState => ({
  id,
  legs: {},
  blocks: 0,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
});

export interface SessionSettings extends OutsideOptions {
  trustedMcpServers: string[];
  piiPacks: readonly string[];
  allowTestData: boolean;
}

type ToolKind = "command" | "read" | "search" | "write" | "fetch" | "other";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
export const filePathOf = (input: Record<string, unknown>) => str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);

/**
 * Agent-agnostic: decide what a tool does from its input shape, then its name. A file tool must
 * carry a path, so an MCP tool like `create_issue` is "other" and its whole input is scanned.
 */
export function toolKind(tool: string, input: Record<string, unknown>): ToolKind {
  const filePath = filePathOf(input);
  if (typeof input.command === "string") return "command";
  const name = tool.toLowerCase();
  if (filePath && /write|edit|create|replace|apply_patch|insert/.test(name)) return "write";
  if (filePath && /^(glob|grep|ls|list|search|find)|search_files|list_dir/.test(name)) return "search";
  if (filePath && /read|view|open|cat/.test(name)) return "read";
  if (typeof input.url === "string") return "fetch";
  return "other";
}

const mcpServer = (tool: string) => /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool)?.[1];
const READ_ONLY_TOOLS = /^(read|glob|grep|ls|notebookread|todowrite|todoread|view|list_dir|search_files|read_file)$/i;

/** Tools the circuit breaker still allows: they only look at local files. */
export function isReadOnly(e: ActionEvent): boolean {
  const kind = toolKind(e.tool, e.input);
  return kind === "read" || kind === "search" || (kind === "other" && READ_ONLY_TOOLS.test(e.tool));
}

const OUTWARD_MCP = /send|post|create|publish|upload|comment|message|push|write|update|share|email|tweet|reply|invite|transfer/i;
const DESTRUCTIVE = new Set(["DES-001", "DES-002", "DES-004", "DES-005", "DES-006", "DES-007", "DES-009"]);

/** Leg C: does this action reach outside the project? */
export function outsideAction(e: ActionEvent, findings: Finding[], ctx: PathContext, s: SessionSettings): OutsideAction | undefined {
  const exfil = findings.find((f) => f.category === "EXFIL");
  if (exfil) return { why: exfil.reason };
  const destroy = findings.find((f) => DESTRUCTIVE.has(f.ruleId));
  if (destroy) return { why: destroy.reason };

  const kind = toolKind(e.tool, e.input);
  if (kind === "command") return outsideCommand(String(e.input.command), ctx, s);
  if (kind === "write") {
    const p = filePathOf(e.input)!;
    const where = classifyPath(p, ctx);
    if (where === "outside" || where === "home" || where === "system" || where === "root") return { why: `writes outside the project (${p})` };
    return undefined;
  }
  if (kind === "fetch") {
    const host = urlHosts(String(e.input.url))[0];
    if (host && !hostAllowed(host, s.allowedHosts)) return { why: `web request to ${host}` };
    return undefined;
  }
  const server = mcpServer(e.tool);
  if (kind === "other" && server && !s.trustedMcpServers.includes(server) && OUTWARD_MCP.test(e.tool.slice(e.tool.lastIndexOf("__") + 2))) {
    return { why: `${e.tool} sends data through MCP server ${server}` };
  }
  return undefined;
}

/** Leg A after a tool result: is a stranger's text now in the agent's context? */
export function strangerSource(e: ShieldEvent, findings: Finding[], ctx: PathContext, s: SessionSettings): string | undefined {
  if (e.kind !== "result") return undefined;
  const inject = findings.some((f) => f.category === "INJECT");
  const source = untrustedSource(e, ctx, s);
  if (inject) return source ? `${source}, with instructions aimed at the agent` : `instructions found in the ${e.tool} result`;
  return source;
}

function untrustedSource(e: Extract<ShieldEvent, { kind: "result" }>, ctx: PathContext, s: SessionSettings): string | undefined {
  const kind = toolKind(e.tool, e.input);
  if (kind === "fetch" || /web_?search|web_?fetch|browser|fetch_?url/i.test(e.tool)) {
    const host = urlHosts(JSON.stringify(e.input))[0];
    return host ? `web content from ${host}` : "web search results";
  }
  const server = mcpServer(e.tool);
  if (server && !s.trustedMcpServers.includes(server)) return `result of MCP server ${server}`;
  if (kind === "command") return fetchesOutsideText(String(e.input.command));
  const p = filePathOf(e.input);
  if (p && (kind === "read" || kind === "search") && isThirdPartyPath(p, ctx)) return `third-party file ${p}`;
  return undefined;
}

/**
 * Leg B: has sensitive data entered the context? `inputFindings` are the findings for the tool input
 * (e.g. SEC-004 for reading .env), `findings` those for the prompt or tool output.
 */
export function sensitiveSource(e: ShieldEvent, findings: Finding[], inputFindings: Finding[], s: SessionSettings): string | undefined {
  const read = inputFindings.find((f) => f.ruleId === "SEC-004" || f.ruleId === "SEC-005" || f.ruleId === "POL-002");
  if (e.kind === "result" && read) return read.reason;
  const secret = findings.find((f) => f.ruleId === "SEC-001" || f.ruleId === "SEC-006");
  if (secret) return secret.reason;
  const text = e.kind === "prompt" ? e.text : e.kind === "result" ? (typeof e.output === "string" ? e.output : JSON.stringify(e.output ?? "")) : "";
  if (text) {
    const pii = filterPII(findPII(text), { packs: s.piiPacks, allowTestData: s.allowTestData }).find((p) => p.type === "CARD" || p.type === "AADHAAR");
    if (pii) return `${pii.type === "CARD" ? "card number" : "Aadhaar number"} in the ${e.kind === "prompt" ? "prompt" : `${e.tool} result`}`;
    if (e.kind === "result" && findSecrets(text).length) return `secret in the ${e.tool} result`;
  }
  return undefined;
}

/** Remember what this event added to the session. Returns a new state. */
export function nextSession(
  state: SessionState,
  e: ShieldEvent,
  decision: Decision,
  legs: { A?: string; B?: string; script?: [string, FlaggedScript] },
  now = new Date(),
): SessionState {
  const at = now.toISOString();
  const next: SessionState = { ...state, legs: { ...state.legs }, updatedAt: at };
  if (decision.action === "block") next.blocks += 1;
  // A blocked prompt never reached the model, so it adds nothing to the context.
  if (decision.action !== "block") {
    if (legs.A && !next.legs.A) next.legs.A = { at, why: legs.A };
    if (legs.B && !next.legs.B) next.legs.B = { at, why: legs.B };
  }
  if (legs.script) {
    const scripts = { ...state.scripts, [legs.script[0]]: legs.script[1] };
    const keys = Object.keys(scripts);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete scripts[k];
    next.scripts = scripts;
  }
  return next;
}

const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "source", "node", "deno", "bun", "python", "python3", "ruby", "perl", "pwsh", "powershell"]);

export const scriptKey = (p: string, ctx: PathContext) => resolvePath(p, ctx).toLowerCase();

/** Is this command running a script this session wrote with a risky command in it? */
export function flaggedScriptRun(command: string, ctx: PathContext, scripts: Record<string, FlaggedScript> | undefined): { path: string; info: FlaggedScript } | undefined {
  if (!scripts || Object.keys(scripts).length === 0) return undefined;
  for (const variant of normalizeCommand(command).variants) {
    for (const s of parseSegments(variant)) {
      const candidates = [s.word, ...(INTERPRETERS.has(s.cmd) ? s.positional.slice(0, 1) : [])];
      for (const c of candidates) {
        if (!c || !/[\\/.]/.test(c)) continue;
        const info = scripts[scriptKey(c, ctx)];
        if (info) return { path: c, info };
      }
    }
  }
  return undefined;
}
