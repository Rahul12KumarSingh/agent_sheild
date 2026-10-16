import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import recording from "../recording.json";
import type { ScenarioRun, ScenarioSummary, StepResult } from "../types";
import { ActionPill, Card, Icon, type IconName, LegsMeter, LevelPill, SplitView } from "../ui";

const ACTOR: Record<StepResult["actor"], { icon: IconName; label: string }> = {
  user: { icon: "user", label: "Developer" },
  agent: { icon: "bot", label: "Agent" },
  tool: { icon: "doc", label: "Tool result" },
  human: { icon: "hand", label: "Developer" },
};
const GATE = { 1: "Gate 1 · content scan", 2: "Gate 2 · path policy", 3: "Gate 3 · Rule of Two" } as Record<number, string>;
const STEP_MS = 1600;

interface Props {
  id?: string;
  auto: boolean;
  offline: boolean;
  gemini: boolean;
  go: (route: string) => void;
}

export function Replay({ id = "S1", auto, offline, gemini, go }: Props) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [run, setRun] = useState<ScenarioRun | null>(null);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [compare, setCompare] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const autoRan = useRef(false);

  useEffect(() => {
    api.scenarios().then((x) => setScenarios(x.scenarios), () => setScenarios([]));
  }, []);

  const start = useCallback(
    async (scenarioId: string) => {
      clearInterval(timer.current);
      setError(null);
      setRun(null);
      setShown(0);
      setCompare(false);
      let result: ScenarioRun;
      try {
        if (offline) throw new Error("offline");
        result = await api.run(scenarioId);
        setRecorded(false);
      } catch (e) {
        if (scenarioId !== "S1" && !offline) {
          setError((e as Error).message);
          return;
        }
        result = recording as ScenarioRun;
        setRecorded(true);
      }
      setRun(result);
      setShown(1);
      timer.current = setInterval(() => {
        setShown((n) => {
          if (n >= result.steps.length) {
            clearInterval(timer.current);
            return n;
          }
          return n + 1;
        });
      }, STEP_MS);
    },
    [offline],
  );

  useEffect(() => () => clearInterval(timer.current), []);
  useEffect(() => {
    if (auto && !autoRan.current) {
      autoRan.current = true;
      void start(id);
    }
  }, [auto, id, start]);

  const visible = run?.steps.slice(0, shown) ?? [];
  const done = run !== null && shown >= run.steps.length;
  const legs = [...visible].reverse().find((s) => s.record)?.record?.legs ?? {};
  const blocker = done ? run.steps.find((s) => s.record?.action === "block") : undefined;
  const current = scenarios.find((s) => s.id === id);

  return (
    <div className="page">
      <div className="replay-grid">
        <Card title="Attack replay" className="scenario-list">
          <p className="muted small">
            Real Claude Code hook messages, sent through the real AgentShield hook and engine. Labelled <b>scripted agent, real AgentShield</b>. Nothing is executed or fetched.
          </p>
          <ul className="scenarios">
            {(scenarios.length ? scenarios : [{ id: "S1", title: "Poisoned README exfiltration", headline: true, expected: "", summary: "", slug: "", steps: 0 }]).map((s) => (
              <li key={s.id}>
                <button type="button" className={`scenario${s.id === id ? " on" : ""}${s.headline ? " headline" : ""}`} onClick={() => go(`#/replay/${s.id}`)}>
                  <span className="scenario-id">{s.id}</span>
                  <span className="scenario-title">{s.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="replay-main">
          <Card
            title={
              <>
                {id} · {run?.scenario.title ?? current?.title ?? "Scenario"} {recorded ? <span className="tag tag-demo">offline recording</span> : null}
              </>
            }
            actions={
              <button type="button" className="btn btn-primary" onClick={() => void start(id)}>
                <Icon name="play" size={16} /> {run ? "Replay again" : "Run"}
              </button>
            }
          >
            <p className="muted">{run?.scenario.summary ?? current?.summary}</p>
            {current?.expected ? (
              <p className="small">
                <b>Expected:</b> {current.expected}
              </p>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            <LegsMeter legs={legs} tripped={Boolean(blocker?.record?.ruleOfTwo)} />

            {run ? (
              <ol className="timeline">
                {visible.map((s) => (
                  <li key={s.index} className={`step actor-${s.actor}${s.record ? ` lvl-${s.record.level.toLowerCase()}` : ""}${s.gate ? " gated" : ""}`}>
                    <span className="step-icon" title={ACTOR[s.actor].label}>
                      <Icon name={ACTOR[s.actor].icon} size={16} />
                    </span>
                    <div className="step-body">
                      <div className="step-head">
                        {s.gate ? <span className="gate">{GATE[s.gate]}</span> : null}
                        {s.record ? <ActionPill action={s.record.action} /> : null}
                        {s.record ? <LevelPill level={s.record.level} score={s.record.score} /> : null}
                        {s.record && !s.ok ? <span className="tag tag-warn">unexpected</span> : null}
                      </div>
                      <p className="step-say">{s.say}</p>
                      {s.record ? <code className="step-code">{s.record.summary}</code> : null}
                      {s.record && s.record.action !== "allow" && s.record.reason ? <p className="step-reason">{s.record.reason}</p> : null}
                    </div>
                  </li>
                ))}
                {!done ? <li className="step step-pending" aria-hidden>…</li> : null}
              </ol>
            ) : (
              <p className="muted empty">Press Run to replay this scenario step by step.</p>
            )}
          </Card>

          {done && blocker?.record ? (
            <>
              <div className="alert" role="alert">
                <Icon name="block" size={22} />
                <div>
                  <b>Attack stopped.</b> {blocker.record.ruleOfTwo ? "The Rule of Two tripped: stranger's text, secrets and an outside action in one session." : blocker.record.reason}
                  <span className="alert-sub">Nothing left the machine. The agent was told what to do instead.</span>
                </div>
              </div>
              <Card title="Split view">
                <SplitView r={blocker.record} gemini={gemini && !offline && !recorded} />
              </Card>
            </>
          ) : null}

          {done && run ? (
            <Card
              title="Without AgentShield"
              actions={
                <button type="button" className="btn btn-ghost" onClick={() => setCompare((x) => !x)} aria-expanded={compare}>
                  {compare ? "Hide" : "Show"} what would have happened
                </button>
              }
              className="without"
            >
              {compare ? (
                <div className="without-body">
                  <p className="tag tag-warn">Simulation: nothing below happened</p>
                  <p>{run.scenario.withoutShield.outcome}</p>
                  <pre className="code leak">{run.scenario.withoutShield.leak}</pre>
                </div>
              ) : (
                <p className="muted small">See what the same steps would have done with no checkpoint in place.</p>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
