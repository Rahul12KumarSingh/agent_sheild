import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { PolicyView } from "../types";
import { Card, Icon, LevelPill } from "../ui";

const ALWAYS_ON = [
  "Live secrets in prompts and tool inputs are blocked",
  "Known data-dump websites are blocked",
  "Deleting the home folder, root or a drive is blocked",
  "Downloaded scripts piped into a shell, and disguised commands, are blocked",
  "The Rule of Two: block or ask, never off",
  "The agent cannot edit, move or delete its own guardrails (hook settings, policy) in any agent app",
  "Reading and searching the codebase is never held up. Secrets, keys and sensitive deletions ask a person",
  "What is about to be committed is checked: live keys, secret files, changed hooks, risky CI lines, hidden text",
  "A redacted audit trail of every decision",
  "If the shield breaks it denies with an explanation, but a broken policy file never blocks everyday work",
];

const LABELS: Record<string, string> = {
  warning_action: "When something is a WARNING",
  rule_of_two: "When the Rule of Two trips",
  mild_notes: "Small notes for MILD findings",
  coach_messages: "Show the safer alternative",
  outside_reads: "Reading files outside the project",
  approvals: "Remember an approved ask",
  allow_test_data: "Known test data allowed",
  circuit_breaker: "Blocks before the session stops",
  allowed_hosts: "Allowed hosts",
  allowed_remotes: "Company git remotes",
  trusted_mcp_servers: "Trusted MCP servers",
  protected_paths: "Extra protected paths",
  extra_ask_commands: "Commands that always ask",
  pii: "Personal data detected",
};

const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(", ") : "none") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

export function Policy() {
  const [profile, setProfile] = useState("developer");
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.policy(profile).then(setPolicy, (e: Error) => setError(e.message));
  }, [profile]);

  const rules = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = policy?.rules ?? [];
    return q ? all.filter((r) => `${r.id} ${r.category} ${r.title}`.toLowerCase().includes(q)) : all;
  }, [policy, query]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!policy) return <div className="page"><p className="muted">Loading the policy...</p></div>;

  return (
    <div className="page">
      <Card
        title={<>Policy: {policy.name}</>}
        actions={
          <label className="field inline">
            <span className="field-label">Role</span>
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              {Object.entries(policy.profiles).sort((a, b) => a[1].rank - b[1].rank).map(([id]) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        }
      >
        <p className="muted small">
          Four layers, strictest wins: company, then role, then project, then personal. A lower layer can always make a rule stricter. It can never loosen a rule marked <Icon name="lock" size={12} title="locked" /> locked.
          Mode: <b>{policy.mode.toUpperCase()}</b>.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Setting</th><th>Value</th><th>Decided by</th></tr>
            </thead>
            <tbody>
              {Object.entries(policy.settings).map(([k, v]) => (
                <tr key={k}>
                  <td>
                    {policy.locked[k] ? <Icon name="lock" size={13} title={`locked by the ${policy.locked[k]}`} /> : null} {LABELS[k] ?? k}
                    <div className="muted small mono">{k}</div>
                  </td>
                  <td className="mono wrap">{show(v)}</td>
                  <td>
                    {policy.sources[k]}
                    {policy.locked[k] ? <div className="muted small">locked by the {policy.locked[k]}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="two-col">
        <Card title="Always on">
          <ul className="checklist">
            {ALWAYS_ON.map((x) => <li key={x}><Icon name="lock" size={13} /> {x}</li>)}
          </ul>
        </Card>
        <Card title="Roles">
          <ul className="profiles">
            {Object.entries(policy.profiles).sort((a, b) => a[1].rank - b[1].rank).map(([id, p]) => (
              <li key={id} className={id === policy.profile ? "on" : ""}>
                <b>{id}</b> <span className="muted small">strictness {p.rank}</span>
                <div className="small">{p.description}</div>
              </li>
            ))}
          </ul>
          <p className="muted small">A person may switch to a stricter role, never to a looser one. Seniority never unlocks leaking or destroying.</p>
        </Card>
      </div>

      <Card title={`Rules (${policy.rules.length})`} actions={<input className="search" type="search" placeholder="Filter rules" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter rules" />}>
        <div className="table-wrap">
          <table className="table rules-table">
            <thead>
              <tr><th>Rule</th><th>Level</th><th>What it catches</th><th>Safe alternative offered</th></tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}<div className="muted small">{r.category}</div></td>
                  <td><LevelPill level={r.level} /></td>
                  <td>{r.title}</td>
                  <td className="muted">{r.alternative}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
