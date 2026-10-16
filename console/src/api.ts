import type { CoachResult, Counters, CustomRule, DraftResult, Info, LocalState, PolicyView, ScenarioRun, ScenarioSummary, SettingsLayer, ShieldRecord, TestResult } from "./types";

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

// ---------- Settings (only on `agentshield setup`, with the token from the link it opened) ----------

const TOKEN_KEY = "agentshield-settings-token";

/** Take the token from `#/settings?t=...`, keep it for this tab only, and remove it from the address bar. */
export function takeToken(): string | null {
  const m = /[?&]t=([A-Za-z0-9_-]{16,})/.exec(window.location.hash);
  try {
    if (m) {
      sessionStorage.setItem(TOKEN_KEY, m[1]!);
      history.replaceState(null, "", `${window.location.pathname}#/overview`);
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return m?.[1] ?? null;
  }
}

const localCall = <T>(token: string, path: string, body?: unknown) =>
  call<T>(path, { method: body === undefined ? "GET" : "POST", headers: { "x-agentshield-token": token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const local = {
  state: (t: string) => localCall<LocalState>(t, "/api/local/state"),
  save: (t: string, b: { layer: SettingsLayer; settings?: Record<string, unknown>; customRules?: CustomRule[]; expectedMtime: number | null }) =>
    localCall<{ ok: true; file: string; ignored: string[]; state: LocalState }>(t, "/api/local/save", b),
  test: (t: string, text: string, draftRules?: CustomRule[]) => localCall<TestResult>(t, "/api/local/test", { text, draftRules }),
  draft: (t: string, description: string) => localCall<DraftResult>(t, "/api/local/draft", { description }),
};

/** The public console's Rule Studio: draft and try rules, nothing is saved. */
export const studio = {
  draft: (description: string) => post<DraftResult>("/api/ai/draft-rules", { description }),
  test: (text: string, rules: CustomRule[]) => post<CoachResult>("/api/evaluate", { text, rules: rules.map(({ source: _s, ...r }) => r) }),
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
