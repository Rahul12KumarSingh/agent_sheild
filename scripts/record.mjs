// Refresh the console's offline recording: run S1 through the built server and save the result.
//   npm run build:server && npm run record
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const port = 18000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [join(root, "dist", "server.js")], {
  env: { ...process.env, PORT: String(port), AGENTSHIELD_SEED: "0", GEMINI_DISABLED: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("console on") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
    setTimeout(() => reject(new Error("server did not start")), 15000);
  });
  const res = await fetch(`http://localhost:${port}/api/scenarios/S1/run`, { method: "POST" });
  if (!res.ok) throw new Error(`run failed: ${res.status}`);
  const run = await res.json();
  if (!run.passed) throw new Error("S1 did not match its expected result; not saving the recording");
  for (const step of run.steps) if (step.record) step.record.demo = true;
  writeFileSync(join(root, "console", "src", "recording.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`Saved console/src/recording.json (${run.steps.length} steps, run ${run.runId})`);
} finally {
  server.kill();
}
