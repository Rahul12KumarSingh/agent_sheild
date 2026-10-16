import { homedir, tmpdir } from "node:os";
import { DEFAULT_POLICY, type EffectivePolicy } from "../policy/index.js";
import { clip, dedupe, hit, RULES, type RuleId } from "./catalog.js";
import { analyzeCommand, commandFindingsInContent, isDumpHost, type OutsideAction, urlHosts } from "./commands.js";
import { exfilRequest, findSecrets, injectionFindings, piiFindings, type PiiOptions, redactSecrets, rewritePrompt } from "./detectors.js";
import { MAX_SCAN } from "./normalize.js";
import {
  classifyPath,
  compileProtectedPaths,
  isAuthorizedKeys,
  isGuardrailPath,
  isInstructionPath,
  isPersistencePath,
  isSecretPath,
  type PathContext,
} from "./paths.js";
import { actionFor, findingWeight, levelOf, scoreOf } from "./score.js";
import {
  filePathOf,
  type FlaggedScript,
  flaggedScriptRun,
  isReadOnly,
  nextSession,
  outsideAction,
  scriptKey,
  sensitiveSource,
  type SessionSettings,
  type SessionState,
  strangerSource,
  toolKind,
} from "./session.js";
import type { Action, ActionEvent, Decision, Finding, ResultEvent, ShieldEvent } from "./types.js";

export * from "./types.js";
export { RULE_IDS, RULES } from "./catalog.js";
export { newSession, type SessionState } from "./session.js";

export interface EngineContext {
  home: string;
  tmpDirs: string[];
}

export const defaultContext = (): EngineContext => ({ home: homedir(), tmpDirs: [tmpdir()] });

export interface EvaluateOptions {
  /** The merged policy. Defaults to the built-in policy. */
  policy?: EffectivePolicy;
  /** Session memory for the Rule of Two and the circuit breaker. Without it, each event is judged alone. */
  session?: SessionState;
  /** Resolve a git remote name to its URL (the hook reads .git/config). */
  remoteUrl?: (name: string) => string | undefined;
}

interface Analysis {
  findings: Finding[];
  disguised: boolean;
}

interface Ctx {
  paths: PathContext;
  policy: EffectivePolicy;
  pii: PiiOptions;
  session: SessionSettings;
}

function writtenContent(input: Record<string, unknown>): string {
  const parts = [input.content, input.new_string, input.new_source, input.new_str, input.text];
  if (Array.isArray(input.edits)) for (const e of input.edits) parts.push((e as Record<string, unknown>)?.new_string);
  return parts.filter((p): p is string => typeof p === "string").join("\n");
}

const SCRIPT_FILE = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$|(^|\/)(makefile|dockerfile|package\.json)$/i;

function analyzeAction(e: ActionEvent, c: Ctx): Analysis {
  const ctx = c.paths;
  const settings = c.policy.settings;
  const findings: Finding[] = [];
  let disguised = false;
  const filePath = filePathOf(e.input);
  const kind = toolKind(e.tool, e.input);

  if (kind === "command") {
    const r = analyzeCommand(String(e.input.command), ctx, { allowedHosts: settings.allowed_hosts, extraAskCommands: settings.extra_ask_commands });
    findings.push(...r.findings);
    disguised = r.disguised;
  }

  if (filePath && (kind === "read" || kind === "search")) {
    if (isSecretPath(filePath, ctx)) findings.push(hit("SEC-004", filePath));
    else if (settings.outside_reads === "ask") {
      const where = classifyPath(filePath, ctx);
      if (where !== "project" && where !== "project-root" && where !== "temp") findings.push(hit("POL-002", filePath));
    }
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
      if (kind === "other" || kind === "fetch") findings.push(...piiFindings(raw, c.pii));
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

function analyzePrompt(text: string, c: Ctx): Finding[] {
  const findings: Finding[] = [];
  const secrets = findSecrets(text);
  if (secrets.length > 0) findings.push(hit("SEC-001", [...new Set(secrets.map((s) => s.type))].join(", "), clip(redactSecrets(text))));
  findings.push(...piiFindings(text, c.pii));
  const exfil = exfilRequest(text);
  if (exfil) findings.push(hit("EXF-006", undefined, exfil));
  return findings;
}

function makeCtx(event: ShieldEvent, engine: EngineContext, opts: EvaluateOptions): Ctx {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const s = policy.settings;
  const base = { cwd: event.cwd, home: engine.home, tmpDirs: engine.tmpDirs };
  const paths: PathContext = { ...base, protectedPaths: s.protected_paths.length ? compileProtectedPaths(s.protected_paths, base) : undefined };
  return {
    paths,
    policy,
    pii: { packs: s.pii, allowTestData: s.allow_test_data },
    session: {
      allowedHosts: s.allowed_hosts,
      allowedRemotes: s.allowed_remotes,
      remoteUrl: opts.remoteUrl,
      trustedMcpServers: s.trusted_mcp_servers,
      piiPacks: s.pii,
      allowTestData: s.allow_test_data,
    },
  };
}

export interface Outcome {
  decision: Decision;
  /** The session after this event, when a session was given. Save it for the next event. */
  session?: SessionState;
}

/** Judge one event, using the policy and what this session has already seen. Pure: no files, no network. */
export function decide(event: ShieldEvent, engine: EngineContext = defaultContext(), opts: EvaluateOptions = {}): Outcome {
  const c = makeCtx(event, engine, opts);
  const settings = c.policy.settings;
  const session = opts.session;
  let analysis: Analysis;

  switch (event.kind) {
    case "prompt":
      analysis = { findings: analyzePrompt(event.text, c), disguised: false };
      break;
    case "action":
      analysis = analyzeAction(event, c);
      break;
    case "result":
      analysis = { findings: analyzeResult(event), disguised: false };
      break;
  }

  // Staged payload: running a script this session wrote with a risky command in it.
  const staged = event.kind === "action" && toolKind(event.tool, event.input) === "command"
    ? flaggedScriptRun(String(event.input.command), c.paths, session?.scripts)
    : undefined;
  if (staged) analysis.findings.push(hit("CNT-003", `${staged.path} (${staged.info.why})`));

  let findings = dedupe(analysis.findings).sort((a, b) => findingWeight(b) - findingWeight(a));
  const baseScore = scoreOf(findings, analysis.disguised);
  let score = baseScore;

  // Session rules: the Rule of Two and the circuit breaker.
  let legC: OutsideAction | undefined;
  let ruleOfTwo = false;
  let breaker = false;
  if (event.kind === "action") {
    legC = outsideAction(event, findings, c.paths, c.session);
    if (!legC && staged?.info.outside) legC = { why: `runs ${staged.path}, which reaches outside` };
    const A = session?.legs.A;
    const B = session?.legs.B;
    if (legC && A && B) {
      ruleOfTwo = true;
      findings = [hit("SES-001", `${A.why}; then ${B.why}; now ${legC.why}`), ...findings];
      score = 100;
    } else if (legC && A && !legC.allowedRemote) {
      findings = [...findings, hit("SES-002", `${legC.why}, after ${A.why}`)];
      score = Math.min(100, baseScore + 20);
    }
    if (session && session.blocks >= settings.circuit_breaker && !isReadOnly(event)) {
      breaker = true;
      findings = [hit("SES-003", `${session.blocks} blocks in this session`), ...findings];
      score = Math.max(score, 90);
    }
  }

  const level = levelOf(score);
  let action: Action = actionFor(event.kind, level, settings.warning_action);
  if (ruleOfTwo && !breaker) {
    const baseAction = actionFor(event.kind, levelOf(baseScore), settings.warning_action);
    const rotAction: Action = settings.rule_of_two === "ask" || legC?.allowedRemote ? "ask" : "block";
    action = baseAction === "block" ? "block" : rotAction;
  }
  if (level === "MILD" && settings.mild_notes === "off") action = "allow";

  let reason = "";
  let safeAlternative: string | undefined;
  if (findings.length > 0) {
    const top = findings[0]!;
    const more = findings.length > 1 ? ` (+${findings.length - 1} more: ${findings.slice(1).map((f) => f.ruleId).join(", ")})` : "";
    reason = `${top.reason}${analysis.disguised && top.ruleId !== "OBF-001" ? ". The command was disguised" : ""}${more}`;
    safeAlternative = RULES[top.ruleId as RuleId]?.alternative ?? "Ask the user to do this step themselves.";
    if (event.kind === "prompt") {
      const rewritten = rewritePrompt(event.text);
      if (rewritten !== event.text) safeAlternative = rewritten;
    }
  }

  const decision: Decision = { action, level, score, findings, reason, ...(safeAlternative ? { safeAlternative } : {}) };
  if (c.policy.mode === "monitor" && action !== "allow") {
    decision.monitored = action;
    decision.action = "allow";
  }

  // What this event adds to the session: A and B are remembered once the content is in the context.
  const legs: { A?: string; B?: string; script?: [string, FlaggedScript] } = {};
  if (event.kind === "result") {
    const inputFindings = analyzeAction({ ...event, kind: "action" }, c).findings;
    legs.A = strangerSource(event, findings, c.paths, c.session);
    legs.B = sensitiveSource(event, findings, inputFindings, c.session);
    legs.script = stagedScript(event, c);
  } else if (event.kind === "prompt") {
    legs.B = sensitiveSource(event, findings, [], c.session);
  }

  const next = session ? nextSession(session, event, decision, legs) : undefined;
  const A = next ? next.legs.A?.why : legs.A;
  const B = next ? next.legs.B?.why : decision.action === "block" ? undefined : legs.B;
  decision.session = { ...(A ? { A } : {}), ...(B ? { B } : {}), ...(legC ? { C: legC.why } : {}), blocks: next?.blocks ?? 0, ruleOfTwo };
  return { decision, session: next };
}

/** After a write: remember a script that carries a risky command, so running it later is caught. */
function stagedScript(e: ResultEvent, c: Ctx): [string, FlaggedScript] | undefined {
  const path = filePathOf(e.input);
  if (!path || toolKind(e.tool, e.input) !== "write" || !SCRIPT_FILE.test(path)) return undefined;
  const risky = commandFindingsInContent(writtenContent(e.input).slice(0, MAX_SCAN), c.paths);
  if (risky.length === 0) return undefined;
  const outside = risky.some((f) => f.category === "EXFIL" || f.category === "DESTROY" || f.ruleId === "EXE-001");
  const top = risky.reduce((a, b) => (findingWeight(b) > findingWeight(a) ? b : a));
  return [scriptKey(path, c.paths), { why: `contains ${top.ruleId}: ${top.reason}`.slice(0, 200), outside }];
}

/** Judge one event. Without a session, the Rule of Two cannot fire. */
export function evaluate(event: ShieldEvent, engine: EngineContext = defaultContext(), opts: EvaluateOptions = {}): Decision {
  return decide(event, engine, opts).decision;
}
