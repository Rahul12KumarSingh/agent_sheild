import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ShieldRecord } from "../types";
import { Card, Icon, kindLabel, LevelPill, SourceTag, SplitView, timeAgo } from "../ui";

interface Props {
  events: ShieldRecord[];
  counters: ReactNode;
  gemini: boolean;
  offline: boolean;
  go: (route: string) => void;
}

export function Live({ events, counters, gemini, offline, go }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "risky">("all");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const list = useMemo(() => {
    const newest = [...events].reverse();
    return filter === "risky" ? newest.filter((e) => e.level !== "CLEAN") : newest;
  }, [events, filter]);
  const current = list.find((e) => e.id === selected) ?? list.find((e) => e.action === "block") ?? list[0];

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          <h1>AI coding agents can read your secrets and run commands.</h1>
          <p>
            One poisoned README is enough to leak a key. AgentShield checks every prompt and every action <em>before</em> it runs,
            blocks what is dangerous, asks a human on judgement calls, and always offers a safe way forward.
          </p>
          <div className="hero-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => go("#/replay/S1?auto=1")}>
              <Icon name="play" size={18} /> Replay the attack
            </button>
            <button type="button" className="btn btn-lg" onClick={() => go("#/coach")}>Try Prompt Coach</button>
          </div>
        </div>
        <div className="hero-rule" aria-label="The Rule of Two">
          <span className="hero-rule-title">The Rule of Two</span>
          <ol>
            <li><b>A</b> a stranger's text</li>
            <li><b>B</b> your secrets</li>
            <li><b>C</b> a way out</li>
          </ol>
          <span className="hero-rule-foot">An agent never gets all three in one session without a human. It works even when the poison is not recognised.</span>
        </div>
      </section>

      {counters}

      <div className="live-grid">
        <Card
          title={<>Live feed {offline ? <span className="tag tag-demo">offline recording</span> : null}</>}
          actions={
            <div className="seg" role="tablist" aria-label="Filter events">
              <button type="button" role="tab" aria-selected={filter === "all"} className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
              <button type="button" role="tab" aria-selected={filter === "risky"} className={filter === "risky" ? "on" : ""} onClick={() => setFilter("risky")}>Risky only</button>
            </div>
          }
          className="feed-card"
        >
          {list.length === 0 ? (
            <p className="muted empty">No events yet. Replay the attack, or connect a real agent with <code>agentshield init</code>.</p>
          ) : (
            <ul className="feed" aria-live="polite">
              {list.map((e) => (
                <li key={e.id}>
                  <button type="button" className={`feed-item${current?.id === e.id ? " on" : ""} lvl-${e.level.toLowerCase()}`} onClick={() => setSelected(e.id)}>
                    <span className="feed-top">
                      <LevelPill level={e.level} />
                      <span className="feed-kind">{kindLabel(e)}</span>
                      {e.ruleOfTwo ? <span className="tag tag-rot">Rule of Two</span> : null}
                      <span className="feed-time">{timeAgo(e.ts)}</span>
                    </span>
                    <span className="feed-summary">{e.summary}</span>
                    <span className="feed-bottom">
                      <SourceTag r={e} />
                      {e.rules.length ? <span className="feed-rules">{e.rules.slice(0, 3).join(" ")}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Event detail" className="detail-card">
          {current ? <SplitView r={current} gemini={gemini && !offline} /> : <p className="muted">Select an event.</p>}
        </Card>
      </div>
    </div>
  );
}
