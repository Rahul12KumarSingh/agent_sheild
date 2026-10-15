import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaude } from "../src/adapters/claude.js";

// Contract test: every real payload captured from Claude Code must parse.
const dir = join(import.meta.dirname, "fixtures", "claude");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe.skipIf(files.length === 0)("real Claude Code fixtures", () => {
  it.each(files)("%s parses", (file) => {
    const event = parseClaude(readFileSync(join(dir, file), "utf8"), false);
    expect(["prompt", "action", "result"]).toContain(event.kind);
  });
});
