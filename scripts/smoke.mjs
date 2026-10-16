// Smoke test a running AgentShield server. Exit code 0 only when every check passes.
//   node scripts/smoke.mjs https://agentshield-xxxx.a.run.app
//   node scripts/smoke.mjs http://localhost:8080
const base = (process.argv[2] ?? "http://localhost:8080").replace(/\/+$/, "");
let failed = 0;

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`  ok    ${name} (${Date.now() - t0} ms)${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const json = async (path, init) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`Smoke test: ${base}`);

await check("health check says ok", async () => {
  // Not /healthz: Cloud Run reserves paths ending in "z".
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000) });
  const body = (await res.text()).trim();
  assert(res.ok && body === "ok", `got ${res.status} '${body}'`);
});

await check("console page loads", async () => {
  const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(10000) });
  const html = await res.text();
  assert(res.ok && html.includes('id="root"'), "no console HTML (was the console built?)");
  assert((res.headers.get("content-security-policy") ?? "").includes("default-src 'self'"), "missing CSP header");
});

let gemini = "off";
await check("info", async () => {
  const info = await json("/api/info");
  gemini = info.gemini.enabled ? `${info.gemini.provider} ${info.gemini.model}` : "off";
  return `policy ${info.policy.name}, Gemini ${gemini}`;
});

await check("Prompt Coach blocks a key and rewrites it", async () => {
  const r = await json("/api/evaluate", { method: "POST", body: JSON.stringify({ text: "Deploy using AKIAZ7Q4M2LX9TRB3KPW now" }) });
  assert(r.decision.action === "block", `action ${r.decision.action}`);
  assert(r.rewrite && !r.rewrite.text.includes("AKIAZ7Q4M2LX9TRB3KPW"), "rewrite still has the key");
  return `rewrite by ${r.rewrite.source}${r.judge ? `, judge ${r.judge.ms} ms` : ""}`;
});

// Open the live stream first, then run S1: the stream must deliver its events.
const controller = new AbortController();
const streamed = (async () => {
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  assert(res.ok, `stream answered ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes("event: shield")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed");
    text += dec.decode(value);
  }
  return text;
})();

await check("S1 replay: three gates, ends in a Rule of Two block", async () => {
  const run = await json("/api/scenarios/S1/run", { method: "POST", body: "{}" });
  assert(run.passed, "a step did not match its expected result");
  const last = run.steps.at(-1);
  assert(last.record.action === "block" && last.record.ruleOfTwo, "last step was not a Rule of Two block");
});

await check("live stream delivers events", async () => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("no event within 10 s")), 10000));
  await Promise.race([streamed, timeout]);
});
controller.abort();

await check("all ten scenarios match their expected results", async () => {
  const { scenarios } = await json("/api/scenarios");
  const bad = [];
  for (const s of scenarios) {
    const run = await json(`/api/scenarios/${s.id}/run`, { method: "POST", body: "{}" });
    if (!run.passed) bad.push(s.id);
  }
  assert(bad.length === 0, `failed: ${bad.join(", ")}`);
  return `${scenarios.length} scenarios`;
});

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
