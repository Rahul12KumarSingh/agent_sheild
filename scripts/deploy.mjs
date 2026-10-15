// Deploy the server to Cloud Run from source and smoke-test /healthz.
// Works the same on macOS, Windows and Linux:
//   npm run deploy -- --project <project-id> [--region asia-south1] [--service agentshield]
import { execFileSync } from "node:child_process";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const project = arg("project");
const region = arg("region", "asia-south1");
const service = arg("service", "agentshield");
if (!project) {
  console.error("Usage: npm run deploy -- --project <project-id> [--region asia-south1]");
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

gcloud([
  "run", "deploy", service,
  "--project", project,
  "--region", region,
  "--source", ".",
  "--allow-unauthenticated",
  "--min-instances", "1",
  "--max-instances", "3",
  "--memory", "512Mi",
  "--timeout", "3600",
  "--labels", `release=${tag}`,
  "--quiet",
]);

const url = gcloud(
  ["run", "services", "describe", service, "--project", project, "--region", region, "--format", "value(status.url)"],
  true,
).trim();
console.log(`Deployed ${tag} to ${url}`);

const res = await fetch(`${url}/healthz`);
const body = (await res.text()).trim();
if (!res.ok || body !== "ok") {
  console.error(`Smoke test FAILED: /healthz returned ${res.status} '${body}'`);
  process.exit(1);
}
console.log(`Smoke test passed: ${url}/healthz says ok`);
