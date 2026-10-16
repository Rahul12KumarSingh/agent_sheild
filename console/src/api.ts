import type { CoachResult, Counters, Info, PolicyView, ScenarioRun, ScenarioSummary, ShieldRecord } from "./types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}`);
  return body;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  info: () => call<Info>("/api/info"),
  events: () => call<{ events: ShieldRecord[]; counters: Counters }>("/api/events?limit=200"),
  scenarios: () => call<{ label: string; scenarios: ScenarioSummary[] }>("/api/scenarios"),
  run: (id: string) => post<ScenarioRun>(`/api/scenarios/${encodeURIComponent(id)}/run`, {}),
  evaluate: (text: string, profile: string) => post<CoachResult>("/api/evaluate", { text, profile }),
  policy: (profile?: string) => call<PolicyView>(`/api/policy${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`),
  explain: (id: string) => post<{ text: string; ms: number; model: string }>("/api/explain", { id }),
};

export type StreamStatus = "connecting" | "live" | "reconnecting";

/** Server-sent events. The browser reconnects by itself; we only report the state. */
export function openStream(onRecord: (r: ShieldRecord, c: Counters) => void, onStatus: (s: StreamStatus) => void): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", () => onStatus("live"));
  es.addEventListener("shield", (e) => {
    try {
      const { record, counters } = JSON.parse((e as MessageEvent<string>).data) as { record: ShieldRecord; counters: Counters };
      onRecord(record, counters);
    } catch {}
  });
  es.onerror = () => onStatus("reconnecting");
  return () => es.close();
}
