import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createGemini } from "../gemini/client.js";
import { ensureYaml, type PolicyFile, parsePolicyFile } from "../policy/index.js";
import { createApp } from "./app.js";
import { loadScenarios } from "./scenarios.js";

// Layout is the same in the repository and in the container: dist/server.js next to scenarios/ and policies/.
const here = dirname(fileURLToPath(import.meta.url));
const findDir = (...candidates: string[]) => candidates.map((c) => resolve(c)).find((c) => existsSync(c));
const env = process.env;

const scenariosDir = findDir(env.AGENTSHIELD_SCENARIOS_DIR ?? "", join(here, "..", "scenarios"), join(process.cwd(), "scenarios"));
const policyPath = [env.AGENTSHIELD_DEMO_POLICY ?? "", join(here, "..", "policies", "acme-bank-demo.yaml"), join(process.cwd(), "policies", "acme-bank-demo.yaml")]
  .map((p) => resolve(p))
  .find((p) => p && existsSync(p));
if (!scenariosDir || !policyPath) {
  console.error("AgentShield server: cannot find scenarios/ or policies/acme-bank-demo.yaml next to the build.");
  process.exit(1);
}

await ensureYaml();
const { parse } = await import("yaml");
const company: PolicyFile = parsePolicyFile(parse(readFileSync(policyPath, "utf8")));
const gemini = createGemini();
const onCloudRun = Boolean(env.K_SERVICE);

const { app, seed } = createApp({
  company,
  scenarios: loadScenarios(scenariosDir),
  stateDir: mkdtempSync(join(tmpdir(), "agentshield-server-")),
  gemini,
  consoleDir: findDir(join(here, "console")),
  ingestToken: env.AGENTSHIELD_INGEST_TOKEN || undefined,
  ingestOpen: env.AGENTSHIELD_INGEST_OPEN === "1" || (!onCloudRun && !env.AGENTSHIELD_INGEST_TOKEN),
  version: env.K_REVISION ?? env.AGENTSHIELD_VERSION ?? "local",
});
if (env.AGENTSHIELD_SEED !== "0") await seed();

// Cloud Run sets PORT (8080). Locally `npm start` uses the same default.
const port = Number(env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AgentShield console on http://localhost:${info.port}  (Gemini: ${gemini.status.enabled ? `${gemini.status.provider}, ${gemini.status.model}` : "off"})`);
});
