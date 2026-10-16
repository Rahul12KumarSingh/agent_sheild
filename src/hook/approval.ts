import { createHash } from "node:crypto";
import { clip } from "../engine/catalog.js";
import { redactSecrets } from "../engine/detectors.js";
import type { SessionState } from "../engine/session.js";
import type { ActionEvent, Decision, ShieldEvent } from "../engine/types.js";

// Approvals that are clearly AgentShield's. Claude Code's own Yes/No box does not show who is asking or why,
// so for a WARNING AgentShield stops the action itself and tells the agent to ask the user. The user replies
// "allow"; that exact action may then run once. Only the user's own prompt can approve (an agent or a web page
// cannot type one), an approval matches one exact action, expires after ten minutes, and SEVERE never qualifies.

const TTL_MS = 10 * 60_000;
const ALLOW = /^\s*(?:ok(?:ay)?[,.]?\s+|yes[,.]?\s+)?(?:allow|approve|approved)(?:\s+(?:it|this|that|once|it once))?\s*[.!]*\s*$/i;

export const isAllowReply = (text: string) => ALLOW.test(text);

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

/** Same tool, same input, same session: the only thing an approval opens. */
export const fingerprint = (e: ActionEvent) => createHash("sha256").update(`${e.tool}\n${stable(e.input)}`).digest("hex").slice(0, 20);

export function actionSummary(e: ActionEvent): string {
  const i = e.input;
  if (typeof i.command === "string") return clip(redactSecrets(i.command), 90);
  const path = [i.file_path, i.notebook_path, i.path, i.url].find((x): x is string => typeof x === "string");
  return clip(redactSecrets(path ? `${e.tool} ${path.split(/[\\/]/).slice(-3).join("/")}` : e.tool), 90);
}

const fresh = (at: string, now: number) => now - Date.parse(at) < TTL_MS;

export interface ApprovalResult {
  decision: Decision;
  session: SessionState;
}

export function applyApproval(event: ShieldEvent, decision: Decision, session: SessionState, now = Date.now()): ApprovalResult {
  if (event.headless) return { decision, session };

  if (event.kind === "action" && decision.action === "ask") {
    const fp = fingerprint(event);
    const summary = actionSummary(event);
    const approved = (session.approved ?? []).filter((a) => fresh(a.at, now));
    const match = approved.find((a) => a.fp === fp);
    if (match) {
      return {
        decision: { ...decision, action: "allow", reason: `Allowed once by you: ${decision.reason}`, approval: { state: "granted", summary } },
        session: { ...session, approved: approved.filter((a) => a !== match) },
      };
    }
    return {
      decision: { ...decision, approval: { state: "needed", summary } },
      session: { ...session, approved, pending: { fp, summary, reason: clip(decision.reason, 200), at: new Date(now).toISOString() } },
    };
  }

  if (event.kind === "prompt" && decision.action !== "block" && isAllowReply(event.text)) {
    const p = session.pending;
    if (p && fresh(p.at, now)) {
      const approved = [...(session.approved ?? []).filter((a) => fresh(a.at, now)), { fp: p.fp, summary: p.summary, at: new Date(now).toISOString() }];
      const { pending: _done, ...rest } = session;
      return { decision: { ...decision, approval: { state: "acknowledged", summary: p.summary } }, session: { ...rest, approved } };
    }
  }
  return { decision, session };
}
