// Copy the built CLI into the Claude Code plugin folder, so one install gives hooks, MCP server and skill.
//   npm run build   (runs this at the end)
//   claude --plugin-dir ./plugin
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const from = join(root, "dist", "cli.js");
if (!existsSync(from)) {
  console.error("dist/cli.js is missing: run the build first.");
  process.exit(1);
}
mkdirSync(join(root, "plugin", "runtime"), { recursive: true });
copyFileSync(from, join(root, "plugin", "runtime", "agentshield.js"));
console.log("plugin/runtime/agentshield.js updated");
