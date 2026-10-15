import { describe, expect, it } from "vitest";
import { scrub } from "../src/cli/capture.js";

describe("capture scrub", () => {
  it("removes a macOS home folder and the username in encoded paths", () => {
    const raw = JSON.stringify({
      cwd: "/Users/asha/work/app",
      transcript_path: "/Users/asha/.claude/projects/-Users-asha-work-app/s.jsonl",
    });
    const out = scrub(raw, "/Users/asha", "asha");
    expect(out).not.toContain("asha");
    expect(JSON.parse(out).cwd).toBe("~/work/app");
  });

  it("removes a Windows home folder, which is JSON-escaped inside the payload", () => {
    const raw = JSON.stringify({
      cwd: "C:\\Users\\Ravi\\work\\app",
      tool_input: { file_path: "C:/Users/Ravi/work/app/.env" },
      transcript_path: "C:\\Users\\Ravi\\.claude\\projects\\C--Users-Ravi-work-app\\s.jsonl",
    });
    const out = scrub(raw, "C:\\Users\\Ravi", "Ravi");
    expect(out).not.toContain("Ravi");
    const parsed = JSON.parse(out);
    expect(parsed.cwd).toBe("~\\work\\app");
    expect(parsed.tool_input.file_path).toBe("~/work/app/.env");
  });
});
