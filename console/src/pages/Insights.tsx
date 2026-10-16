import { type ReactNode, useMemo } from "react";
import type { Level, ShieldRecord } from "../types";
import { Card, LevelPill } from "../ui";

const LEVELS: Level[] = ["SEVERE", "WARNING", "MILD", "CLEAN"];

function Bars({ rows }: { rows: { label: ReactNode; key: string; value: number; cls?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track"><span className={`bar-fill ${r.cls ?? ""}`} style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="bar-value">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function Insights({ events }: { events: ShieldRecord[] }) {
  const stats = useMemo(() => {
    const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
    const byCategory = new Map<string, number>();
    const byRule = new Map<string, number>();
    const byAction = new Map<string, number>();
    for (const e of events) {
      byLevel[e.level]++;
      byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
      for (const f of e.findings) {
        byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
        byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
      }
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { byLevel, byCategory: sorted(byCategory), byRule: sorted(byRule).slice(0, 10), byAction: sorted(byAction), demo: events.filter((e) => e.demo).length };
  }, [events]);

  return (
    <div className="page">
      <p className="muted small">From the {events.length} most recent events in the live buffer{stats.demo ? `, including ${stats.demo} labelled demo events` : ""}. Nothing is stored beyond this buffer.</p>
      <div className="two-col">
        <Card title="By severity">
          <Bars rows={LEVELS.map((l) => ({ key: l, label: <LevelPill level={l} />, value: stats.byLevel[l], cls: `fill-${l.toLowerCase()}` }))} />
        </Card>
        <Card title="By decision">
          <Bars rows={stats.byAction.map(([a, n]) => ({ key: a, label: a, value: n, cls: `fill-${a}` }))} />
        </Card>
        <Card title="By category">
          {stats.byCategory.length ? <Bars rows={stats.byCategory.map(([c, n]) => ({ key: c, label: c, value: n }))} /> : <p className="muted">No findings yet.</p>}
        </Card>
        <Card title="Top rules">
          {stats.byRule.length ? <Bars rows={stats.byRule.map(([r, n]) => ({ key: r, label: <code>{r}</code>, value: n }))} /> : <p className="muted">No findings yet.</p>}
        </Card>
      </div>
    </div>
  );
}
