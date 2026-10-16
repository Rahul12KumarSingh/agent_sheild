import { useCallback, useEffect, useRef, useState } from "react";
import { api, openStream, type StreamStatus } from "./api";
import { Coach } from "./pages/Coach";
import { Insights } from "./pages/Insights";
import { Live } from "./pages/Live";
import { Policy } from "./pages/Policy";
import { Replay } from "./pages/Replay";
import recording from "./recording.json";
import type { Counters, Info, ScenarioRun, ShieldRecord } from "./types";
import { Icon, kindLabel } from "./ui";

type Status = StreamStatus | "offline";

function useRoute(): [string, (r: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || "#/live");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/live");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: string) => {
    if (window.location.hash === r) setHash(r);
    window.location.hash = r;
    window.scrollTo({ top: 0 });
  }, []);
  return [hash, go];
}

const offlineEvents = () => (recording as ScenarioRun).steps.flatMap((s) => (s.record ? [s.record] : []));

/** The live feed: initial load, then server-sent events. Falls back to a labelled recording when the API is down. */
function useFeed() {
  const [events, setEvents] = useState<ShieldRecord[]>([]);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [info, setInfo] = useState<Info | null>(null);
  const [alert, setAlert] = useState<ShieldRecord | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let closed = false;
    api.info().then((i) => !closed && setInfo(i), () => undefined);
    api.events().then(
      (x) => {
        if (closed) return;
        setEvents(x.events);
        setCounters(x.counters);
      },
      () => {
        if (closed) return;
        setStatus("offline");
        setEvents(offlineEvents());
      },
    );
    const close = openStream(
      (r, c) => {
        failures.current = 0;
        setEvents((prev) => (prev.some((e) => e.id === r.id) ? prev : [...prev.slice(-299), r]));
        setCounters(c);
        if (r.action === "block" && r.level === "SEVERE") setAlert(r);
      },
      (s) => {
        if (s === "live") {
          failures.current = 0;
          setStatus("live");
          return;
        }
        failures.current++;
        // A few failed reconnects in a row: show the labelled recording instead of a blank page.
        if (failures.current >= 3) {
          setStatus("offline");
          setEvents((prev) => (prev.length ? prev : offlineEvents()));
        } else setStatus("reconnecting");
      },
    );
    return () => {
      closed = true;
      close();
    };
  }, []);

  return { events, counters, status, info, alert, dismiss: () => setAlert(null) };
}

const NAV = [
  { route: "#/live", label: "Live" },
  { route: "#/replay", label: "Attack replay" },
  { route: "#/coach", label: "Prompt Coach" },
  { route: "#/policy", label: "Policy" },
  { route: "#/insights", label: "Insights" },
];

const STATUS_TEXT: Record<Status, string> = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline recording" };

export function CountersStrip({ counters: c, offline }: { counters: Counters | null; offline: boolean }) {
  return (
    <section className="counters" aria-label="Counters">
      <div className="counter"><span className="counter-n">{c?.blocked ?? "–"}</span><span className="counter-l">Threats stopped</span></div>
      <div className="counter"><span className="counter-n">{c?.asked ?? "–"}</span><span className="counter-l">Asked a human</span></div>
      <div className="counter"><span className="counter-n">{c?.secretsKeptOut ?? "–"}</span><span className="counter-l">Secrets kept out</span></div>
      <div className="counter"><span className="counter-n">{c?.ruleOfTwo ?? "–"}</span><span className="counter-l">Rule of Two trips</span></div>
      <div className="counter"><span className="counter-n">{c?.promptsCoached ?? "–"}</span><span className="counter-l">Prompts coached</span></div>
      <p className="counters-note">{offline ? "Offline: showing a recorded replay." : c?.demoEvents ? `Since the server started. Includes ${c.demoEvents} labelled demo events.` : "Since the server started."}</p>
    </section>
  );
}

export function App() {
  const [route, go] = useRoute();
  const { events, counters, status, info, alert, dismiss } = useFeed();
  const offline = status === "offline";
  const gemini = Boolean(info?.gemini.enabled);
  const [path, query] = route.replace(/^#/, "").split("?");
  const parts = (path ?? "/live").split("/").filter(Boolean);
  const page = parts[0] ?? "live";

  useEffect(() => {
    if (!alert) return;
    const t = setTimeout(dismiss, 12_000);
    return () => clearTimeout(t);
  }, [alert, dismiss]);

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <a className="brand" href="#/live" aria-label="AgentShield home">
          <Icon name="shield" size={22} />
          <span>AgentShield</span>
        </a>
        <div className="topbar-badges">
          <span className="badge" title="Company policy in force">{info?.policy.name ?? "Acme Bank (demo)"}</span>
          <span className="badge" title="Mode">{(info?.policy.mode ?? "enforce").toUpperCase()}</span>
          <span className={`badge ${gemini ? "badge-gemini" : ""}`} title="Gemini is optional: it can only make a decision stricter">
            <Icon name="spark" size={12} /> {gemini ? info!.gemini.model : "Gemini off"}
          </span>
          <span className={`status status-${status}`} role="status">
            <span className="dot" aria-hidden /> {STATUS_TEXT[status]}
          </span>
        </div>
      </header>

      <nav className="nav" aria-label="Pages">
        {NAV.map((n) => (
          <a key={n.route} href={n.route} className={page === n.route.slice(2) ? "on" : ""} aria-current={page === n.route.slice(2) ? "page" : undefined}>
            {n.label}
          </a>
        ))}
      </nav>

      {alert && page !== "replay" ? (
        <div className="alert alert-float" role="alert">
          <Icon name="block" size={22} />
          <div>
            <b>{alert.ruleOfTwo ? "Rule of Two: blocked" : "Blocked"}</b> · {kindLabel(alert)} · <span className="mono">{alert.summary.slice(0, 90)}</span>
            <span className="alert-sub">{alert.reason.slice(0, 160)}</span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => { dismiss(); go("#/live"); }}>View</button>
          <button type="button" className="btn btn-ghost" aria-label="Dismiss" onClick={dismiss}>✕</button>
        </div>
      ) : null}

      <main id="main">
        {page === "replay" ? (
          <Replay key={parts[1] ?? "S1"} id={parts[1] ?? "S1"} auto={query?.includes("auto=1") ?? false} offline={offline} gemini={gemini} go={go} />
        ) : page === "coach" ? (
          <Coach offline={offline} />
        ) : page === "policy" ? (
          <Policy />
        ) : page === "insights" ? (
          <>
            <CountersStrip counters={counters} offline={offline} />
            <Insights events={events} />
          </>
        ) : (
          <Live events={events} counters={<CountersStrip counters={counters} offline={offline} />} gemini={gemini} offline={offline} go={go} />
        )}
      </main>

      <footer className="footer">
        <p>
          The console only evaluates text: it never runs a command or fetches a URL. Demo data is labelled, counters are never faked, and nothing you paste is stored.
          Decisions are made by plain code on the developer's machine. Gemini, when on, can only make a decision stricter.
        </p>
      </footer>
    </div>
  );
}
