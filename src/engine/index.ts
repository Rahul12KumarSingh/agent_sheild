import { homedir, tmpdir } from "node:os";
import { clip, dedupe, hit, RULES, type RuleId } from "./catalog.js";
import { analyzeCommand, commandFindingsInContent, isDumpHost, urlHosts } from "./commands.js";
import { findSecrets, injectionFindings, piiFindings, redactSecrets, rewritePrompt } from "./detectors.js";
import { MAX_SCAN } from "./normalize.js";
import {
  classifyPath,
  isAuthorizedKeys,
  isGuardrailPath,
  isInstructionPath,
  isPersistencePath,
  isSecretPath,
  type PathContext,
} from "./paths.js";
import { actionFor, findingWeight, levelOf, scoreOf } from "./score.js";
import type { ActionEvent, Decision, Finding, ResultEvent, ShieldEvent } from "./types.js";

export * from "./types.js";
export { RULE_IDS, RULES } from "./catalog.js";

export interface EngineContext {
  home: string;
  tmpDirs: string[];
}

export const defaultContext = (): EngineContext => ({ home: homedir(), tmpDirs: [tmpdir()] });

type ToolKind = "command" | "read" | "search" | "write" | "fetch" | "other";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Agent-agnostic: decide what a tool does from its input shape, then its name. A file tool must
 * carry a path, so an MCP tool like `create_issue` is "other" and its whole input is scanned.
 */
function toolKind(tool: string, input: Record<string, unknown>, filePath: string | undefined): ToolKind {
  if (typeof input.command === "string") return "command";
  const name = tool.toLowerCase();
  if (filePath && /write|edit|create|replace|apply_patch|insert/.test(name)) return "write";
  if (filePath && /^(glob|grep|ls|list|search|find)|search_files|list_dir/.test(name)) return "search";
  if (filePath && /read|view|open|cat/.test(name)) return "read";
  if (typeof input.url === "string") return "fetch";
  return "other";
}

function writtenContent(input: Record<string, unknown>): string {
  const parts = [input.content, input.new_string, input.new_source, input.new_str, input.text];
  if (Array.isArray(input.edits)) for (const e of input.edits) parts.push((e as Record<string, unknown>)?.new_string);
  return parts.filter((p): p is string => typeof p === "string").join("\n");
}

const SCRIPT_FILE = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$|(^|\/)(makefile|dockerfile|package\.json)$/i;

function analyzeAction(e: ActionEvent, ctx: PathContext): { findings: Finding[]; disguised: boolean } {
  const findings: Finding[] = [];
  let disguised = false;
  const filePath = str(e.input.file_path) ?? str(e.input.notebook_path) ?? str(e.input.path);
  const kind = toolKind(e.tool, e.input, filePath);

  if (kind === "command") {
    const r = analyzeCommand(str(e.input.command)!, ctx);
    findings.push(...r.findings);
    disguised = r.disguised;
  }

  if (filePath && (kind === "read" || kind === "search") && isSecretPath(filePath, ctx)) {
    findings.push(hit("SEC-004", filePath));
  }

  if (filePath && kind === "write") {
    if (isGuardrailPath(filePath, ctx)) findings.push(hit("TAM-001", filePath));
    else if (isAuthorizedKeys(filePath, ctx)) findings.push(hit("PER-002", filePath));
    else if (isInstructionPath(filePath, ctx)) findings.push(hit("TAM-002", filePath));
    else if (isPersistencePath(filePath, ctx)) findings.push(hit("PER-001", filePath));
    else {
      const where = classifyPath(filePath, ctx);
      if (where === "outside" || where === "home" || where === "system" || where === "root") findings.push(hit("DES-009", filePath));
    }

    const content = writtenContent(e.input).slice(0, MAX_SCAN);
    if (findSecrets(content).length > 0 && !isSecretPath(filePath, ctx)) findings.push(hit("SEC-003", filePath));
    const risky = commandFindingsInContent(content, ctx);
    if (risky.length > 0) {
      const top = risky.reduce((a, b) => (findingWeight(b) > findingWeight(a) ? b : a));
      const detail = `${top.ruleId} in ${filePath}`;
      findings.push(SCRIPT_FILE.test(filePath) && top.level === "SEVERE" ? hit("CNT-001", detail, top.excerpt) : hit("CNT-002", detail, top.excerpt));
    }
  }

  // Anything the tool sends out: live secrets and data-dump sites, in any field.
  if (kind !== "write") {
    const raw = JSON.stringify(e.input).slice(0, MAX_SCAN);
    const secrets = findSecrets(raw);
    if (secrets.length > 0) findings.push(hit("SEC-002", secrets.map((s) => s.type).join(", "), clip(redactSecrets(raw))));
    if (kind !== "command") {
      for (const h of urlHosts(raw)) if (isDumpHost(h)) findings.push(hit("EXF-001", h, clip(redactSecrets(raw))));
      if (kind === "other" || kind === "fetch") findings.push(...piiFindings(raw));
    }
  }

  return { findings, disguised };
}

function analyzeResult(e: ResultEvent): Finding[] {
  const text = (typeof e.output === "string" ? e.output : JSON.stringify(e.output ?? "")).slice(0, MAX_SCAN);
  const findings = injectionFindings(text);
  const secrets = findSecrets(text);
  if (secrets.length > 0) findings.push(hit("SEC-006", secrets.map((s) => s.type).join(", ")));
  return findings;
}

function analyzePrompt(text: string): Finding[] {
  const findings: Finding[] = [];
  const secrets = findSecrets(text);
  if (secrets.length > 0) findings.push(hit("SEC-001", [...new Set(secrets.map((s) => s.type))].join(", "), clip(redactSecrets(text))));
  findings.push(...piiFindings(text));
  return findings;
}

export function evaluate(event: ShieldEvent, engine: EngineContext = defaultContext()): Decision {
  const ctx: PathContext = { cwd: event.cwd, home: engine.home, tmpDirs: engine.tmpDirs };
  let findings: Finding[];
  let disguised = false;

  switch (event.kind) {
    case "prompt":
      findings = analyzePrompt(event.text);
      break;
    case "action":
      ({ findings, disguised } = analyzeAction(event, ctx));
      break;
    case "result":
      findings = analyzeResult(event);
      break;
  }

  findings = dedupe(findings).sort((a, b) => findingWeight(b) - findingWeight(a));
  const score = scoreOf(findings, disguised);
  const level = levelOf(score);
  const action = actionFor(event.kind, level);
  if (action === "allow") return { action, level, score, findings, reason: "" };

  const top = findings[0]!;
  const more = findings.length > 1 ? ` (+${findings.length - 1} more: ${findings.slice(1).map((f) => f.ruleId).join(", ")})` : "";
  const reason = `${top.reason}${disguised && top.ruleId !== "OBF-001" ? ". The command was disguised" : ""}${more}`;

  let safeAlternative: string = RULES[top.ruleId as RuleId]?.alternative ?? "Ask the user to do this step themselves.";
  if (event.kind === "prompt") {
    const rewritten = rewritePrompt(event.text);
    if (rewritten !== event.text) safeAlternative = rewritten;
  }

  return { action, level, score, findings, reason, safeAlternative };
}
