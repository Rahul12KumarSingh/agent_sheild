// Gemini, used for three optional jobs: judge gray-zone prompts, write a nicer safer prompt, explain a decision.
// It can only RAISE a risk level, every rewrite is re-checked by the engine, and every call has a 3 second budget.
// Gemini never sees a raw secret: text is redacted before it leaves the process.
//
// Providers, in order:
//   GEMINI_API_KEY set           -> Gemini API (Google AI Studio key), for local development
//   on Cloud Run (K_SERVICE set) -> Vertex AI with the service's own identity (no key to leak)
//   GEMINI_PROVIDER=vertex       -> Vertex AI with GOOGLE_CLOUD_PROJECT and a metadata-server token
//   GEMINI_DISABLED=1            -> off

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const TIMEOUT_MS = 3000;

export type Provider = "ai-studio" | "vertex" | "off";

export interface GeminiStatus {
  enabled: boolean;
  provider: Provider;
  model: string;
}

export interface GeminiRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
}

/** Sends one request and returns the model's raw text. Swappable for tests. */
export type Transport = (req: GeminiRequest, signal: AbortSignal) => Promise<string>;

export interface Gemini {
  status: GeminiStatus;
  /** Returns parsed JSON, or throws (timeout, network, bad JSON). Callers must fall back. */
  json<T>(req: GeminiRequest): Promise<{ value: T; ms: number }>;
}

export function detectProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  if (env.GEMINI_DISABLED === "1") return "off";
  if (env.GEMINI_API_KEY) return "ai-studio";
  if (env.K_SERVICE || env.GEMINI_PROVIDER === "vertex") return "vertex";
  return "off";
}

function body(req: GeminiRequest) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: req.maxOutputTokens ?? 1024,
      responseMimeType: "application/json",
      responseSchema: req.schema,
    },
  });
}

function textOf(response: unknown): string {
  const parts = (response as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

async function post(url: string, headers: Record<string, string>, payload: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload, signal });
  if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return textOf(await res.json());
}

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
let token: { value: string; expires: number } | undefined;
let project: string | undefined;

async function metadata(path: string): Promise<Response> {
  return fetch(`${METADATA}${path}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(1000) });
}

async function vertexToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await metadata("/instance/service-accounts/default/token");
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function vertexProject(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.GOOGLE_CLOUD_PROJECT) return env.GOOGLE_CLOUD_PROJECT;
  if (project) return project;
  const res = await metadata("/project/project-id");
  if (!res.ok) throw new Error(`metadata project ${res.status}`);
  project = (await res.text()).trim();
  return project;
}

export function httpTransport(provider: Provider, model: string, env: NodeJS.ProcessEnv = process.env): Transport {
  if (provider === "ai-studio") {
    return (req, signal) =>
      post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": env.GEMINI_API_KEY! }, body(req), signal);
  }
  return async (req, signal) => {
    const location = env.GEMINI_LOCATION || "global";
    const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const [bearer, proj] = await Promise.all([vertexToken(), vertexProject(env)]);
    const url = `https://${host}/v1/projects/${encodeURIComponent(proj)}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    return post(url, { authorization: `Bearer ${bearer}` }, body(req), signal);
  };
}

export function createGemini(opts: { env?: NodeJS.ProcessEnv; transport?: Transport; provider?: Provider; model?: string; timeoutMs?: number } = {}): Gemini {
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? (opts.transport ? "ai-studio" : detectProvider(env));
  const model = opts.model ?? env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const transport = opts.transport ?? (provider === "off" ? undefined : httpTransport(provider, model, env));
  return {
    status: { enabled: Boolean(transport), provider: transport ? provider : "off", model },
    async json<T>(req: GeminiRequest) {
      if (!transport) throw new Error("Gemini is not configured");
      const t0 = Date.now();
      const text = await transport(req, AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS));
      const value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as T;
      return { value, ms: Date.now() - t0 };
    },
  };
}
