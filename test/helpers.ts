import { evaluate, type EngineContext, type EvaluateOptions, newSession, type SessionState } from "../src/engine/index.js";
import type { ShieldEvent } from "../src/engine/types.js";

// Fixed contexts so tests give the same result on macOS, Windows and Linux.
export const POSIX: EngineContext = { home: "/home/dev", tmpDirs: ["/tmp"] };
export const WINDOWS: EngineContext = { home: "C:\\Users\\dev", tmpDirs: ["C:\\Users\\dev\\AppData\\Local\\Temp"] };
export const POSIX_CWD = "/home/dev/project";
export const WINDOWS_CWD = "C:\\Users\\dev\\project";

const base = { agent: "claude" as const, sessionId: "test", cwd: POSIX_CWD, headless: false };

export const cmd = (command: string, cwd = POSIX_CWD): ShieldEvent => ({ ...base, cwd, kind: "action", tool: "Bash", input: { command } });
export const ps = (command: string): ShieldEvent => ({ ...base, cwd: WINDOWS_CWD, kind: "action", tool: "PowerShell", input: { command } });
export const read = (file_path: string): ShieldEvent => ({ ...base, kind: "action", tool: "Read", input: { file_path } });
export const write = (file_path: string, content: string): ShieldEvent => ({ ...base, kind: "action", tool: "Write", input: { file_path, content } });
export const edit = (file_path: string, new_string = "x"): ShieldEvent => ({ ...base, kind: "action", tool: "Edit", input: { file_path, old_string: "y", new_string } });
export const fetchUrl = (url: string): ShieldEvent => ({ ...base, kind: "action", tool: "WebFetch", input: { url, prompt: "summarise" } });
export const mcp = (tool: string, input: Record<string, unknown>): ShieldEvent => ({ ...base, kind: "action", tool, input });
export const prompt = (text: string): ShieldEvent => ({ ...base, kind: "prompt", text });
export const result = (tool: string, output: unknown): ShieldEvent => ({ ...base, kind: "result", tool, input: {}, output });

export const isWindowsEvent = (e: ShieldEvent) => /^[a-zA-Z]:\\/.test(e.cwd);
export const run = (e: ShieldEvent, opts: EvaluateOptions = {}) => evaluate(e, isWindowsEvent(e) ? WINDOWS : POSIX, opts);

/** A session that already holds the given Rule of Two legs. */
export function sessionWith(legs: { A?: string; B?: string }, blocks = 0): SessionState {
  const s = newSession("test");
  if (legs.A) s.legs.A = { at: s.createdAt, why: legs.A };
  if (legs.B) s.legs.B = { at: s.createdAt, why: legs.B };
  s.blocks = blocks;
  return s;
}

/** Invisible Unicode tag characters spelling out `text`. */
export const tags = (text: string) => [...text].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

export const b64 = (s: string) => Buffer.from(s).toString("base64");
export const psEncoded = (s: string) => Buffer.from(s, "utf16le").toString("base64");

/** A fake, live-looking key. Never a real one. */
export const FAKE_AWS_KEY = "AKIAZ7Q4M2LX9TRB3KPW";
export const FAKE_GITHUB_TOKEN = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

/** A unified diff (`git diff -U0` style) that adds the given lines to one file. */
export function fakeDiff(path: string, added: string[], mode: "new" | "modify" = "modify"): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(mode === "new" ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${path}`]),
    `+++ b/${path}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join("\n");
}
