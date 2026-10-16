// Send all traffic back to an earlier revision, then run the smoke test. One command, under a minute.
//   npm run rollback -- --project <project-id> [--region asia-southeast1] [--service agentshield] [--to <revision-name>]
// Without --to, it picks the newest ready revision that is not serving traffic now.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const project = arg("project");
const region = arg("region", "asia-southeast1");
const service = arg("service", "agentshield");
if (!project) {
  console.error("Usage: npm run rollback -- --project <project-id> [--region asia-southeast1] [--to <revision>]");
  process.exit(1);
}

const gcloud = (args, capture = false) =>
  execFileSync("gcloud", args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", shell: process.platform === "win32", encoding: "utf8" });

const t0 = Date.now();
let target = arg("to");
if (!target) {
  const svc = JSON.parse(gcloud(["run", "services", "describe", service, "--project", project, "--region", region, "--format", "json"], true));
  const serving = new Set((svc.status?.traffic ?? []).filter((t) => t.percent > 0).map((t) => t.revisionName));
  const revisions = JSON.parse(
    gcloud(["run", "revisions", "list", "--service", service, "--project", project, "--region", region, "--sort-by", "~metadata.creationTimestamp", "--format", "json"], true),
  );
  const ready = revisions.filter((r) => (r.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"));
  target = ready.find((r) => !serving.has(r.metadata.name))?.metadata.name;
  if (!target) {
    console.error("No earlier ready revision found. Pass one with --to <revision>.");
    process.exit(1);
  }
  console.log(`Serving now: ${[...serving].join(", ")}. Rolling back to: ${target}`);
}

gcloud(["run", "services", "update-traffic", service, "--project", project, "--region", region, "--to-revisions", `${target}=100`, "--quiet"]);
const url = gcloud(["run", "services", "describe", service, "--project", project, "--region", region, "--format", "value(status.url)"], true).trim();
const smoke = spawnSync(process.execPath, [join(import.meta.dirname, "smoke.mjs"), url], { stdio: "inherit" });
console.log(`\nRollback to ${target} took ${Math.round((Date.now() - t0) / 1000)} s. Smoke test: ${smoke.status === 0 ? "green" : "FAILED"}.`);
console.log("To send traffic to the newest revision again later: gcloud run services update-traffic " + `${service} --to-latest --project ${project} --region ${region}`);
process.exit(smoke.status ?? 1);
