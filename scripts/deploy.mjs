// Deploy the console and API to Cloud Run from source, then run the smoke test against it.
// Works the same on macOS, Windows and Linux:
//   npm run deploy -- --project <project-id> [--region asia-southeast1] [--service agentshield]
//                     [--gemini-model gemini-3.5-flash-lite] [--no-gemini] [--ingest-token <token>]
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const project = arg("project");
const region = arg("region", "asia-southeast1");
const service = arg("service", "agentshield");
const model = arg("gemini-model", "gemini-3.5-flash-lite");
const ingestToken = arg("ingest-token");
if (!project) {
  console.error("Usage: npm run deploy -- --project <project-id> [--region asia-southeast1] [--gemini-model <id>] [--no-gemini] [--ingest-token <token>]");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const tag = `v${stamp}`;

// On Windows gcloud is a .cmd file, which needs a shell to run. None of our arguments contain spaces.
function gcloud(args, capture = false) {
  return execFileSync("gcloud", args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
}

console.log("Enabling the APIs (no-op when already on)...");
gcloud(["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "aiplatform.googleapis.com", "--project", project, "--quiet"]);

if (!has("no-gemini")) {
  // Gemini on Vertex AI uses the service's own identity: no API key exists to leak.
  const number = gcloud(["projects", "describe", project, "--format", "value(projectNumber)"], true).trim();
  const sa = `${number}-compute@developer.gserviceaccount.com`;
  console.log(`Granting Vertex AI access to ${sa}...`);
  gcloud(["projects", "add-iam-policy-binding", project, "--member", `serviceAccount:${sa}`, "--role", "roles/aiplatform.user", "--condition", "None", "--quiet"], true);
}

const envVars = [
  `AGENTSHIELD_VERSION=${tag}`,
  has("no-gemini") ? "GEMINI_DISABLED=1" : `GEMINI_MODEL=${model}`,
  "GEMINI_LOCATION=global",
  ...(ingestToken ? [`AGENTSHIELD_INGEST_TOKEN=${ingestToken}`] : []),
].join(",");

gcloud([
  "run", "deploy", service,
  "--project", project,
  "--region", region,
  "--source", ".",
  "--allow-unauthenticated",
  "--min-instances", "1",
  "--max-instances", "3",
  "--concurrency", "250",
  "--memory", "512Mi",
  "--timeout", "3600",
  "--set-env-vars", envVars,
  "--labels", `release=${tag}`,
  "--tag", tag,
  "--quiet",
]);

const url = gcloud(["run", "services", "describe", service, "--project", project, "--region", region, "--format", "value(status.url)"], true).trim();
console.log(`\nDeployed ${tag} to ${url}\n`);

const smoke = spawnSync(process.execPath, [join(import.meta.dirname, "smoke.mjs"), url], { stdio: "inherit" });
if (smoke.status !== 0) {
  console.error(`\nSmoke test FAILED. Roll back with: npm run rollback -- --project ${project} --region ${region}`);
  process.exit(1);
}
console.log(`\nLive: ${url}`);
