import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createGemini } from "../gemini/client.js";
import type { ShieldRecord } from "../hook/telemetry.js";
import { companyPolicyPath, ensureYaml, type PolicyFile, parsePolicyFile, readPolicyFile, userDir } from "../policy/index.js";
import { createApp } from "./app.js";
import { loadScenarios } from "./scenarios.js";

// Layout is the same in the repository and in the container: dist/server.js next to scenarios/ and policies/.
const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const first = (kind: "file" | "dir", ...candidates: (string | undefined)[]) =>
  candidates
    .filter((c): c is string => Boolean(c))
    .map((c) => resolve(c))
    .find((c) => existsSync(c) && (kind === "dir" ? statSync(c).isDirectory() : statSync(c).isFile()));

// `agentshield setup` starts this server in local mode: 127.0.0.1 only, the developer's real policy and history.
const local = env.AGENTSHIELD_LOCAL === "1" && env.AGENTSHIELD_LOCAL_TOKEN && env.AGENTSHIELD_LOCAL_CWD
  ? { token: env.AGENTSHIELD_LOCAL_TOKEN, cwd: env.AGENTSHIELD_LOCAL_CWD, port: Number(env.PORT ?? 7357), env }
  : undefined;
const scenariosDir = first("dir", env.AGENTSHIELD_SCENARIOS_DIR, join(here, "..", "scenarios"), join(process.cwd(), "scenarios"));
const policyPath = first("file", env.AGENTSHIELD_DEMO_POLICY, join(here, "..", "policies", "acme-bank-demo.yaml"), join(process.cwd(), "policies", "acme-bank-demo.yaml"));
if (!scenariosDir || !policyPath) {
  console.error("AgentShield server: cannot find scenarios/ or policies/acme-bank-demo.yaml next to the build.");
  process.exit(1);
}

await ensureYaml();
const { parse } = await import("yaml");
const companyPath = local ? companyPolicyPath(env) : undefined;
const company: PolicyFile = local ? (companyPath ? readPolicyFile(companyPath, "company") : {}) : parsePolicyFile(parse(readFileSync(policyPath, "utf8")));
const gemini = createGemini();
const onCloudRun = Boolean(env.K_SERVICE);

const { app, seed, feed } = createApp({
  company,
  scenarios: loadScenarios(scenariosDir),
  stateDir: mkdtempSync(join(tmpdir(), "agentshield-server-")),
  gemini,
  consoleDir: first("dir", join(here, "console")),
  ingestToken: env.AGENTSHIELD_INGEST_TOKEN || undefined,
  ingestOpen: env.AGENTSHIELD_INGEST_OPEN === "1" || (!onCloudRun && !env.AGENTSHIELD_INGEST_TOKEN),
  version: env.K_REVISION ?? env.AGENTSHIELD_VERSION ?? "local",
  local,
});
if (local) {
  // Your own recent history from the hook's local audit log, so the Live page shows real events.
  try {
    const lines = readFileSync(join(userDir(env), "events.jsonl"), "utf8").trim().split("\n").slice(-200);
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as ShieldRecord;
        if (r.id && r.action && r.kind) feed.add(r);
      } catch {}
    }
  } catch {}
} else if (env.AGENTSHIELD_SEED !== "0") await seed();

// Cloud Run sets PORT (8080). Locally `npm start` uses the same default.
const port = Number(env.PORT ?? 8080);
serve({ fetch: app.fetch, port, ...(local ? { hostname: "127.0.0.1" } : {}) }, (info) => {
  if (local) return; // `agentshield setup` prints its own link
  console.log(`AgentShield console on http://localhost:${info.port}  (Gemini: ${gemini.status.enabled ? `${gemini.status.provider}, ${gemini.status.model}` : "off"})`);
});
