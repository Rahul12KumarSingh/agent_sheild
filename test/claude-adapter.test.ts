import { describe, expect, it } from "vitest";
import { formatClaude, parseClaude } from "../src/adapters/claude.js";
import { evaluate, TEST_MARKER } from "../src/engine/index.js";

const pre = (command: string) =>
  JSON.stringify({
    session_id: "s1",
    cwd: "/tmp/project",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

const prompt = (text: string) =>
  JSON.stringify({ session_id: "s1", cwd: "/tmp/project", hook_event_name: "UserPromptSubmit", prompt: text });

function run(raw: string, headless = false) {
  const event = parseClaude(raw, headless);
  return formatClaude(evaluate(event), event);
}

describe("Claude Code adapter (P0 stub)", () => {
  it("parses the three hook events", () => {
    expect(parseClaude(pre("ls"), false)).toMatchObject({ kind: "action", tool: "Bash", sessionId: "s1" });
    expect(parseClaude(prompt("hi"), false)).toMatchObject({ kind: "prompt", text: "hi" });
    const post = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "x" });
    expect(parseClaude(post, false)).toMatchObject({ kind: "result", tool: "Read", output: "x" });
  });

  it("rejects unknown events so the hook fails closed", () => {
    expect(() => parseClaude(JSON.stringify({ hook_event_name: "Nope" }), false)).toThrow();
    expect(() => parseClaude("not json", false)).toThrow();
  });

  it("denies a command with the test marker using exit code 2 and a reason", () => {
    const out = run(pre(`echo ${TEST_MARKER}`));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("TEST-000");
    expect(out.stderr).toContain("Safe alternative");
  });

  it("blocks a prompt with the test marker and offers a safer prompt", () => {
    const out = run(prompt(`please ${TEST_MARKER}`));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Safer prompt");
  });

  it("stays silent on normal work", () => {
    expect(run(pre("npm test"))).toEqual({ exitCode: 0 });
    expect(run(prompt("fix the failing test"))).toEqual({ exitCode: 0 });
  });

  it("turns ask into deny when headless", () => {
    const event = parseClaude(pre("cat .env"), true);
    const out = formatClaude({ action: "ask", level: "WARNING", score: 50, findings: [], reason: "reads secrets" }, event);
    expect(out.exitCode).toBe(2);
  });

  it("emits a PreToolUse ask when a human is present", () => {
    const event = parseClaude(pre("cat .env"), false);
    const out = formatClaude({ action: "ask", level: "WARNING", score: 50, findings: [], reason: "reads secrets" }, event);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout!).hookSpecificOutput.permissionDecision).toBe("ask");
  });
});
