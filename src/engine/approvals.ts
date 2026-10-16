import type { ApprovalItem, Finding, ShieldEvent } from "./types.js";
import type { PendingAsk, SessionState } from "./session.js";

// "Allow once, allow similar": when a person approves an ask, the same thing is not asked again in this session.
// An approval is a (rule, target) pair: the rule that fired and the exact file, host or command it fired on.
// It only turns an ask into a note. Scores, the Rule of Two and every other rule stay exactly as they were.

/** Rules that ask every time: a person should see each one. */
const ALWAYS_ASK = new Set(["SES-001", "SES-002", "SES-003", "POL-001", "PER-001", "PER-002", "TAM-001", "TAM-003", "CNT-001", "CNT-003", "GIT-003"]);

/** Keys, tokens and credential stores: approving one read does not approve the next. */
const CROWN_JEWELS = /\/\.ssh\/|\/\.aws\/credentials|\/\.gnupg|\/\.kube\/config|\.(pem|key|p12|pfx|ppk|kdbx|jks|keystore)$|\/\.git-credentials$|\/\.netrc$|\/_netrc$|\/\.npmrc$|\/\.pypirc$|\/\.docker\/config\.json$|\/library\/keychains\/|\/\.config\/gcloud\/|\/\.azure\/|\/\.vault-token$|\/\.config\/gh\/hosts\.yml$|\/\.pgpass$/;

export function rememberable(ruleId: string, target: string): boolean {
  if (ALWAYS_ASK.has(ruleId)) return false;
  if (ruleId === "SEC-004" && CROWN_JEWELS.test(target.toLowerCase())) return false;
  return true;
}

export const normalizeTarget = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);

/** Small stable hash (FNV-1a, two passes): the engine stays free of Node built-ins. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export const approvalId = (ruleId: string, target: string) => `${ruleId}:${shortHash(normalizeTarget(target))}`;

/** What the person is asked to approve for one finding. */
export function itemOf(f: Finding): ApprovalItem {
  const target = f.target ?? normalizeTarget(f.excerpt ?? f.reason);
  return { ruleId: f.ruleId, target, label: f.reason.slice(0, 160), rememberable: rememberable(f.ruleId, target) };
}

/** Findings a person has to say yes to: WARNING and above. MILD findings are only notes. */
export const needsApproval = (f: Finding) => f.level === "WARNING" || f.level === "SEVERE";

export type ApprovedLookup = (ruleId: string, target: string) => boolean;

/** Every finding that needs a person is covered by an earlier approval. */
export function allCovered(findings: Finding[], approved: ApprovedLookup | undefined): boolean {
  if (!approved) return false;
  const need = findings.filter(needsApproval);
  return need.length > 0 && need.every((f) => {
    const item = itemOf(f);
    return item.rememberable && approved(item.ruleId, item.target);
  });
}

/**
 * What a tool call is, independent of which hook reported it and of extra fields: the same command or the same file
 * is the same call. (Cursor asks in beforeShellExecution and reports the result in postToolUse, with different fields.)
 */
export function eventSig(e: ShieldEvent): string {
  if (e.kind === "prompt") return `prompt:${shortHash(e.text)}`;
  if (typeof e.input.command === "string") return `cmd:${shortHash(normalizeTarget(e.input.command))}`;
  const path = e.input.file_path ?? e.input.path ?? e.input.filePath;
  if (typeof path === "string") return `file:${e.tool}:${shortHash(normalizeTarget(path))}`;
  return `call:${shortHash(`${e.tool}\u0000${stable(e.input)}`)}`;
}

/** Every way to recognise this call again, most specific first: its own id, then what it is. */
export const eventSigs = (e: ShieldEvent): string[] => (e.kind !== "prompt" && e.toolUseId ? [`id:${e.toolUseId}`, eventSig(e)] : [eventSig(e)]);

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "";
}

const HOUR = 60 * 60 * 1000;

/** The action was asked about: remember what to approve if the agent app runs it. */
export function recordPending(state: SessionState, sigs: string[], items: ApprovalItem[], now = new Date()): SessionState {
  const keep = items.filter((i) => i.rememberable);
  if (keep.length === 0) return state;
  const pending: Record<string, PendingAsk> = {};
  for (const [k, v] of Object.entries(state.pending ?? {})) if (now.getTime() - Date.parse(v.at) < HOUR) pending[k] = v;
  const ask: PendingAsk = { at: now.toISOString(), items: keep.map((i) => ({ id: approvalId(i.ruleId, i.target), ruleId: i.ruleId, target: i.target, label: i.label })) };
  for (const sig of sigs) pending[sig] = ask;
  const keys = Object.keys(pending);
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete pending[k];
  return { ...state, pending };
}

/** The result of a call we asked about arrived: a person said yes, so remember it. */
export function promote(state: SessionState, sigs: string[], now = new Date()): SessionState {
  const ask = sigs.map((s) => state.pending?.[s]).find(Boolean);
  if (!ask) return state;
  const approved = { ...state.approved };
  for (const item of ask.items) approved[item.id] = now.toISOString();
  const pending = { ...state.pending };
  // The same ask may be filed under several signatures.
  for (const [k, v] of Object.entries(pending)) if (v.at === ask.at && v.items[0]?.id === ask.items[0]?.id) delete pending[k];
  const ids = Object.keys(approved);
  for (const k of ids.slice(0, Math.max(0, ids.length - 200))) delete approved[k];
  return { ...state, approved, pending };
}
