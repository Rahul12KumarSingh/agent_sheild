import { type ReactNode, useState } from "react";
import { api } from "./api";
import type { Action, Level, ShieldRecord } from "./types";

// ---------- Icons (inline SVG, no icon font, no external requests) ----------

const PATHS = {
  shield: "M12 2 4 5v6c0 5.2 3.4 9.7 8 11 4.6-1.3 8-5.8 8-11V5l-8-3Z",
  block: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-6.3 5.1 11.2 11.2A8 8 0 0 1 5.7 7.1Zm12.6 9.8L7.1 5.7a8 8 0 0 1 11.2 11.2Z",
  warn: "M12 3 1.5 21h21L12 3Zm0 5.5 6.6 11H5.4L12 8.5ZM11 11v4h2v-4h-2Zm0 5v2h2v-2h-2Z",
  info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v2h-2V7Zm0 4h2v6h-2v-6Z",
  check: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 14.2-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7Z",
  lock: "M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z",
  user: "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5Z",
  bot: "M11 2h2v3h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4V2ZM8.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM9 21h6v1H9v-1Z",
  doc: "M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V8h4.5L13 3.5ZM8 12v2h8v-2H8Zm0 4v2h6v-2H8Z",
  hand: "M9 2a1.5 1.5 0 0 1 1.5 1.5V11h1V2.5a1.5 1.5 0 0 1 3 0V11h1V4.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-12.6 4.2L3 14.2a1.5 1.5 0 0 1 2.3-1.9L7.5 15V3.5A1.5 1.5 0 0 1 9 2Z",
  play: "M8 5v14l11-7L8 5Z",
  copy: "M8 3h10a2 2 0 0 1 2 2v12h-2V5H8V3ZM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z",
  spark: "M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7L12 2Zm7 13 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-3a15 15 0 0 0-1.3-4 8 8 0 0 1 4.3 4ZM12 4c.8 1.1 1.5 2.5 1.9 4h-3.8C10.5 6.5 11.2 5.1 12 4ZM4.3 14a8 8 0 0 1 0-4h3.4a16 16 0 0 0 0 4H4.3Zm.8 2h3a15 15 0 0 0 1.3 4 8 8 0 0 1-4.3-4Zm3-8h-3a8 8 0 0 1 4.3-4 15 15 0 0 0-1.3 4ZM12 20c-.8-1.1-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.9-1.9 4Zm2.3-6H9.7a14 14 0 0 1 0-4h4.6a14 14 0 0 1 0 4Zm.3 6a15 15 0 0 0 1.3-4h3a8 8 0 0 1-4.3 4Zm1.7-6a16 16 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}

// ---------- Severity: always an icon and a word, never colour alone ----------

const LEVEL_ICON: Record<Level, IconName> = { SEVERE: "block", WARNING: "warn", MILD: "info", CLEAN: "check" };

export function LevelPill({ level, score }: { level: Level; score?: number }) {
  return (
    <span className={`pill level-${level.toLowerCase()}`}>
      <Icon name={LEVEL_ICON[level]} size={13} />
      {level}
      {score !== undefined ? <span className="pill-score">{score}</span> : null}
    </span>
  );
}

const ACTION_TEXT: Record<Action, string> = { block: "BLOCKED", ask: "ASKED A HUMAN", note: "NOTED", allow: "ALLOWED" };
const ACTION_ICON: Record<Action, IconName> = { block: "block", ask: "hand", note: "info", allow: "check" };

export function ActionPill({ action, monitored }: { action: Action; monitored?: Action }) {
  return (
    <span className={`pill action-${action}`}>
      <Icon name={ACTION_ICON[action]} size={13} />
      {ACTION_TEXT[action]}
      {monitored ? <span className="pill-note">monitor mode, would {monitored}</span> : null}
    </span>
  );
}

export function SourceTag({ r }: { r: ShieldRecord }) {
  if (r.agent === "scripted") return <span className="tag tag-demo">Scripted agent, real AgentShield</span>;
  if (r.demo) return <span className="tag tag-demo">demo data</span>;
  if (r.agent === "claude") return <span className="tag tag-real">Real Claude Code</span>;
  if (r.agent === "copilot") return <span className="tag tag-real">Real Copilot</span>;
  if (r.agent === "cursor") return <span className="tag tag-real">Real Cursor</span>;
  if (r.agent === "windsurf") return <span className="tag tag-real">Real Windsurf</span>;
  if (r.agent === "gemini") return <span className="tag tag-real">Real Gemini CLI</span>;
  return <span className="tag">{r.agent}</span>;
}

export const kindLabel = (r: ShieldRecord) => (r.kind === "prompt" ? "Prompt" : r.kind === "result" ? `${r.tool ?? "Tool"} result` : (r.tool ?? "Action"));

export function timeAgo(ts: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---------- The Rule of Two meter ----------

const LEGS = [
  { key: "A", name: "Stranger's text", hint: "web page, README, issue, tool output" },
  { key: "B", name: "Sensitive data", hint: ".env, keys, customer data" },
  { key: "C", name: "Outside action", hint: "upload, push, delete, send" },
] as const;

export function LegsMeter({ legs, tripped, compact }: { legs: { A?: string; B?: string; C?: string }; tripped?: boolean; compact?: boolean }) {
  return (
    <div className={`legs${tripped ? " legs-tripped" : ""}${compact ? " legs-compact" : ""}`} role="group" aria-label="Rule of Two session meter">
      {LEGS.map((l) => {
        const on = Boolean(legs[l.key]);
        return (
          <div key={l.key} className={`leg${on ? " leg-on" : ""}`} title={legs[l.key] ?? l.hint}>
            <span className="leg-key" aria-hidden>{l.key}</span>
            <span className="leg-body">
              <span className="leg-name">{l.name}</span>
              {!compact ? <span className="leg-why">{on ? legs[l.key] : l.hint}</span> : null}
            </span>
            <span className="sr-only">{on ? "present" : "not present"}</span>
          </div>
        );
      })}
      {tripped ? <div className="legs-verdict"><Icon name="block" size={14} /> All three in one session: blocked</div> : null}
    </div>
  );
}

// ---------- Split view: what the agent tried, what AgentShield did ----------

export function SplitView({ r, gemini }: { r: ShieldRecord; gemini?: boolean }) {
  return (
    <div className="split">
      <section className="split-side split-tried">
        <h3>What the agent tried</h3>
        <div className="split-meta">
          <span className="chip">{kindLabel(r)}</span>
          <SourceTag r={r} />
        </div>
        <pre className="code">{r.summary || "(empty)"}</pre>
        {r.legs.A || r.legs.B || r.legs.C ? <LegsMeter legs={r.legs} tripped={r.ruleOfTwo} compact /> : null}
      </section>
      <section className="split-side split-did">
        <h3>What AgentShield did, and why</h3>
        <div className="split-verdict">
          <ActionPill action={r.action} monitored={r.monitored} />
          <LevelPill level={r.level} score={r.score} />
        </div>
        {r.reason ? <p className="reason">{r.reason}</p> : <p className="muted">Nothing risky found. The agent's own permission rules stay in charge.</p>}
        {r.approved ? <p className="muted small"><Icon name="check" size={12} /> Approved earlier in this session: asked once, then remembered. Blocks and the Rule of Two are never lifted by an approval.</p> : null}
        {r.findings.length ? (
          <ul className="rules">
            {r.findings.map((f, i) => (
              <li key={f.ruleId}>
                <code>{f.ruleId}</code> <span className="muted">{f.category}</span> {i === 0 && r.reason.startsWith(f.reason.slice(0, 40)) ? null : f.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {r.safeAlternative && r.action !== "allow" ? (
          <div className="alt">
            <span className="alt-label">Safe alternative</span>
            {r.safeAlternative}
          </div>
        ) : null}
        {r.delivered && (r.delivered.message || r.delivered.exitCode !== 0) ? (
          <details className="delivered">
            <summary>What the agent app received (exit code {r.delivered.exitCode})</summary>
            <pre className="code small">{r.delivered.message}</pre>
          </details>
        ) : null}
        {gemini && r.level !== "CLEAN" ? <Explain id={r.id} /> : null}
      </section>
    </div>
  );
}

function Explain({ id }: { id: string }) {
  const [state, setState] = useState<{ text?: string; error?: string; model?: string; loading?: boolean }>({});
  if (state.text) {
    return (
      <div className="explain">
        <span className="explain-label"><Icon name="spark" size={13} /> Gemini explains ({state.model})</span>
        {state.text}
      </div>
    );
  }
  return (
    <div className="explain-row">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={state.loading}
        onClick={() => {
          setState({ loading: true });
          api.explain(id).then((x) => setState({ text: x.text, model: x.model }), (e: Error) => setState({ error: e.message }));
        }}
      >
        <Icon name="spark" size={14} /> {state.loading ? "Asking Gemini..." : "Explain in plain English"}
      </button>
      {state.error ? <span className="muted small">{state.error}</span> : null}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`}>
      {title || actions ? (
        <header className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}
