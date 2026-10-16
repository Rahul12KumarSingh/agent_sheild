import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { demoCommand } from "../src/cli/demo.js";
import { findSecrets } from "../src/engine/detectors.js";

const root = mkdtempSync(join(tmpdir(), "agentshield-demo-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cli = join(root, "cli.js");
writeFileSync(cli, "// bundle\n");

describe("agentshield demo", () => {
  it("creates a realistic project with AgentShield on and lists the prompts to try", () => {
    const out = demoCommand(["shop"], { cwd: root, cli });
    expect(out.exitCode).toBe(0);
    for (const f of ["package.json", "main.tf", ".env", "README.md", ".claude/settings.json"]) expect(existsSync(join(root, "shop", f)), f).toBe(true);
    expect(out.stdout).toContain("terraform destroy -auto-approve");
  });

  it("uses only fake secrets: no live-looking key in the files", () => {
    expect(findSecrets(readFileSync(join(root, "shop", ".env"), "utf8"))).toEqual([]);
  });

  it("never writes into a folder that has files", () => {
    mkdirSync(join(root, "busy"));
    writeFileSync(join(root, "busy", "keep.txt"), "x");
    expect(demoCommand(["busy"], { cwd: root, cli }).exitCode).toBe(1);
  });
});
