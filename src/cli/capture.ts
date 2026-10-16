import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Remove the home folder and username from a raw payload so it can be committed after a review.
 * Handles Windows paths, which appear JSON-escaped (C:\\Users\\name) inside the payload,
 * and encoded paths such as Claude Code's "-Users-name-project" folder names.
 */
export function scrub(raw: string, home: string, username: string): string {
  let out = raw;
  const escapedHome = JSON.stringify(home).slice(1, -1);
  for (const form of new Set([escapedHome, home, home.replace(/\\/g, "/")])) {
    if (form) out = out.split(form).join("~");
  }
  if (username) out = out.split(username).join("user");
  return out;
}

/**
 * Spike S5: save raw hook payloads so real agent formats become test fixtures.
 * Enabled by the --capture <dir> flag or AGENTSHIELD_CAPTURE_DIR (the flag also works in Windows shells).
 * Never throws: capturing must not change a hook decision.
 */
export function capturePayload(agent: string, raw: string, dir = process.env.AGENTSHIELD_CAPTURE_DIR): void {
  if (!dir) return;
  try {
    let event = "unknown";
    try {
      const p = JSON.parse(raw) as { hook_event_name?: string; prompt?: unknown; toolResult?: unknown; toolName?: unknown };
      // Copilot's camelCase payloads carry no event name: tell them apart by shape.
      event = String(p.hook_event_name ?? (p.prompt !== undefined ? "userPromptSubmitted" : p.toolResult !== undefined ? "postToolUse" : p.toolName !== undefined ? "preToolUse" : "unknown"));
    } catch {}
    const target = join(dir, agent);
    mkdirSync(target, { recursive: true });
    const name = `${event}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`;
    writeFileSync(join(target, name), scrub(raw, homedir(), userInfo().username));
  } catch {}
}
