import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookOutput } from "../adapters/claude.js";

// `agentshield setup`: the settings page in your browser. Only on 127.0.0.1, with a fresh secret token
// in the link it opens, so no other website and no agent can change your settings through it.

const DEFAULT_PORT = 7357;

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

async function pickPort(wanted?: number): Promise<number> {
  if (wanted) return wanted;
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 20; p++) if (await portFree(p)) return p;
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {}
}

export async function setupCommand(args: string[], cli: string): Promise<HookOutput> {
  const server = join(dirname(cli), "server.js");
  if (!existsSync(server)) {
    return { exitCode: 1, stderr: "The settings page ships with the npm package. Run it with:\n  npx agentshield-hooks setup" };
  }
  const i = args.indexOf("--port");
  const wanted = i >= 0 ? Number(args[i + 1]) : undefined;
  if (wanted !== undefined && !(Number.isInteger(wanted) && wanted > 0 && wanted < 65536)) return { exitCode: 1, stderr: "--port expects a number" };
  const port = await pickPort(wanted);
  const token = randomBytes(24).toString("base64url");

  Object.assign(process.env, {
    AGENTSHIELD_LOCAL: "1",
    AGENTSHIELD_LOCAL_TOKEN: token,
    AGENTSHIELD_LOCAL_CWD: process.cwd(),
    PORT: String(port),
    AGENTSHIELD_SEED: "0",
  });
  await import(pathToFileURL(server).href);

  const url = `http://127.0.0.1:${port}/#/settings?t=${token}`;
  const open = !args.includes("--no-open");
  if (open) openBrowser(url);
  return {
    exitCode: 0,
    stdout: [
      "",
      open ? "  AgentShield settings are opening in your browser." : "  AgentShield settings are ready.",
      `  ${open ? "If nothing opened, go to" : "Open"}: ${url}`,
      "",
      `  Editing settings for: ${process.cwd()}`,
      "  The page is only reachable from this computer. Press Ctrl+C here when you are done.",
      "",
    ].join("\n"),
  };
}
