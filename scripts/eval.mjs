// Write docs/EVALUATION.md from measured results (corpus, mutations, latency).
//   npm run build && npm run eval
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const res = spawnSync(process.execPath, [vitest, "run", "test/evaluation.test.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, AGENTSHIELD_WRITE_EVAL: "1" },
});
process.exit(res.status ?? 1);
