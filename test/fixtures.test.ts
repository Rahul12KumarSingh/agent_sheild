import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaude } from "../src/adapters/claude.js";
import { pickAdapter } from "../src/adapters/index.js";

// Contract test: every real payload captured from Claude Code must parse, and be recognised as Claude Code
// whatever name the hook file gave (Copilot CLI, Cursor and VS Code all read .claude/settings.json too).
const dir = join(import.meta.dirname, "fixtures", "claude");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe.skipIf(files.length === 0)("real Claude Code fixtures", () => {
  it.each(files)("%s parses", (file) => {
    const event = parseClaude(readFileSync(join(dir, file), "utf8"), false);
    expect(["prompt", "action", "result"]).toContain(event!.kind);
  });

  it.each(files)("%s is recognised as Claude Code", (file) => {
    const input = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    for (const hint of ["claude", "copilot", "cursor", "auto", undefined]) expect(pickAdapter(hint, input)?.id).toBe("claude");
  });

  it("a tool result carries the same tool_use_id as the call before it (how an approval is matched)", () => {
    const pre = files.filter((f) => f.startsWith("PreToolUse")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).tool_use_id as string);
    const post = files.filter((f) => f.startsWith("PostToolUse")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).tool_use_id as string);
    expect(post.length).toBeGreaterThan(0);
    for (const id of post) expect(pre).toContain(id);
  });
});
