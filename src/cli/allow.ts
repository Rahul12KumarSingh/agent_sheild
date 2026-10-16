import type { HookOutput } from "../adapters/types.js";
import { normalizeTarget, rememberable } from "../engine/index.js";
import { pathTarget } from "../engine/paths.js";
import { RULE_IDS } from "../engine/catalog.js";
import { addApproval, listApprovals, removeApprovals } from "../hook/approvals-store.js";
import { loadPolicyAsync, userDir } from "../policy/index.js";
import { homedir, tmpdir } from "node:os";
import { checkText } from "./check.js";

// `agentshield allow` and `agentshield approvals`: the "one-time setup" side of "allow once, allow similar".
// An approval only turns an ask into a note. It never lifts a block, the Rule of Two or a company lock.
// These are for a person at a terminal: the agent running them is tamper (TAM-001).

/** Rules whose target is a file or folder (the rest are about a command). */
const PATH_RULES = new Set(["SEC-004", "POL-002", "DES-002", "DES-009", "DES-010", "TAM-002", "GIT-001", "GIT-002", "GIT-004", "GIT-005"]);

const USAGE = `Usage:
  agentshield allow "<command>"             work out what would be asked, and approve it for this project
  agentshield allow <RULE> "<path or text>"  approve one thing, for example: agentshield allow SEC-004 .env.test
                                             paths may use * and **   (agentshield allow DES-010 "build/**")
  agentshield approvals                     list what is approved for this project
  agentshield approvals revoke <number|all>
An approval only turns an ask into a note. Blocks, the Rule of Two and company-locked rules are never lifted.`;

/** A path target for the store. Stars are kept (they are patterns), everything else is resolved like the engine does. */
function pathPattern(text: string, ctx: { cwd: string; home: string; tmpDirs: string[] }): string {
  return pathTarget(text.replace(/\*/g, "\u0001"), ctx).replace(/\u0001/g, "*");
}

export async function allowCommand(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<HookOutput> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return { exitCode: args.length === 0 ? 1 : 0, [args.length === 0 ? "stderr" : "stdout"]: USAGE };
  const stateDir = userDir(opts.env);

  let policy;
  try {
    policy = await loadPolicyAsync({ cwd: opts.cwd, env: opts.env });
  } catch (err) {
    return { exitCode: 1, stderr: `A policy file could not be loaded, so nothing can be approved: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (policy.settings.approvals === "off") {
    return { exitCode: 1, stderr: `Approvals are turned off (set by the ${policy.sources.approvals}${policy.locked.approvals ? ", locked" : ""}): every ask is asked every time.` };
  }

  const ctx = { cwd: opts.cwd, home: homedir(), tmpDirs: [tmpdir()] };

  // agentshield allow SEC-004 .env.test
  if (/^[A-Z]{3}-\d{3}$/.test(args[0]!)) {
    const rule = args[0]!;
    const text = args.slice(1).join(" ").trim();
    if (!(RULE_IDS as string[]).includes(rule)) return { exitCode: 1, stderr: `Unknown rule ${rule}.` };
    if (!text) return { exitCode: 1, stderr: `Say what to approve, for example: agentshield allow ${rule} "<path or text>"` };
    const target = PATH_RULES.has(rule) ? pathPattern(text, ctx) : normalizeTarget(text);
    if (!rememberable(rule, target)) return { exitCode: 1, stderr: `${rule} on ${target} is asked every time: it cannot be approved ahead of time.` };
    addApproval(stateDir, opts.cwd, rule, target, `${rule} ${text}`);
    return { exitCode: 0, stdout: `Approved for this project: ${rule}  ${target}\nIt turns an ask into a note. List or remove it with \`agentshield approvals\`.` };
  }

  // agentshield allow "cat .env"
  const text = args.join(" ");
  const { decision } = checkText(text, policy, opts.cwd, "command");
  if (decision.action === "block") {
    return { exitCode: 1, stderr: `Not approvable: AgentShield blocks this (${decision.findings.map((f) => f.ruleId).join(", ")}): ${decision.reason}\nBlocks are never lifted by an approval.` };
  }
  const asks = (decision.asks ?? []).filter((a) => a.rememberable);
  if (asks.length === 0) {
    return { exitCode: 0, stdout: decision.action === "ask" ? "This kind of ask is shown every time and cannot be approved ahead of time." : "Nothing to approve: AgentShield already lets this through." };
  }
  for (const a of asks) addApproval(stateDir, opts.cwd, a.ruleId, a.target, a.label);
  return { exitCode: 0, stdout: `Approved for this project:\n${asks.map((a) => `  ${a.ruleId}  ${a.target}`).join("\n")}\nIt turns an ask into a note. List or remove it with \`agentshield approvals\`.` };
}

export function approvalsCommand(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): HookOutput {
  const stateDir = userDir(opts.env);
  const [sub, which] = args;
  if (sub === "revoke") {
    if (!which) return { exitCode: 1, stderr: "Say which: agentshield approvals revoke <number|all>" };
    const n = which === "all" ? "all" : Number(which);
    if (n !== "all" && !Number.isInteger(n)) return { exitCode: 1, stderr: "Say which: a number from the list, or all." };
    const removed = removeApprovals(stateDir, opts.cwd, n);
    return removed ? { exitCode: 0, stdout: `Removed ${removed} approval${removed === 1 ? "" : "s"}.` } : { exitCode: 1, stderr: "No such approval. Run `agentshield approvals` to see the list." };
  }
  const list = listApprovals(stateDir, opts.cwd);
  if (list.length === 0) return { exitCode: 0, stdout: "No saved approvals for this project. (An ask you approve in the agent's own prompt is remembered for that session only.)" };
  return { exitCode: 0, stdout: ["Approved for this project:", ...list.map((a, i) => `  ${i + 1}. ${a.rule}  ${a.target}   (${a.at.slice(0, 10)})`)].join("\n") };
}
