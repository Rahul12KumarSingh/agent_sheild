import { describe, expect, it } from "vitest";
import { findPII, findSecrets, redactSecrets, rewritePrompt } from "../src/engine/detectors.js";
import { normalizeCommand } from "../src/engine/normalize.js";
import { classifyPath, isSecretPath, resolvePath } from "../src/engine/paths.js";
import { levelOf, scoreOf } from "../src/engine/score.js";
import { hit } from "../src/engine/catalog.js";
import { FAKE_AWS_KEY } from "./helpers.js";

const posix = { cwd: "/home/dev/project", home: "/home/dev", tmpDirs: ["/tmp"] };
const win = { cwd: "C:\\Users\\dev\\project", home: "C:\\Users\\dev", tmpDirs: [] };

describe("paths", () => {
  it.each([
    ["~", "/home/dev"], ["$HOME", "/home/dev"], ["${HOME}/x", "/home/dev/x"], ["~/*", "/home/dev"],
    ["/*", "/"], ["../other", "/home/dev/other"], ["./dist", "/home/dev/project/dist"],
  ])("posix %s -> %s", (raw, want) => expect(resolvePath(raw, posix)).toBe(want));

  it.each([
    ["$env:USERPROFILE", "c:/users/dev"], ["%USERPROFILE%", "c:/users/dev"], ["~", "c:/users/dev"],
    ["C:\\", "c:/"], ["C:\\*", "c:/"], [".\\dist", "c:/users/dev/project/dist"], ["C:/Users/Dev/Project/x", "c:/users/dev/project/x"],
  ])("windows %s -> %s", (raw, want) => expect(resolvePath(raw, win)).toBe(want));

  it("classifies blast radius", () => {
    expect(classifyPath("/", posix)).toBe("root");
    expect(classifyPath("~", posix)).toBe("home");
    expect(classifyPath("/home", posix)).toBe("system");
    expect(classifyPath(".", posix)).toBe("project-root");
    expect(classifyPath("node_modules", posix)).toBe("project");
    expect(classifyPath("/tmp/x", posix)).toBe("temp");
    expect(classifyPath("/opt/app", posix)).toBe("outside");
    expect(classifyPath("C:\\Windows", win)).toBe("system");
    expect(classifyPath("C:\\", win)).toBe("root");
  });

  it("knows secret files from their safe look-alikes", () => {
    for (const p of [".env", ".env.local", "~/.aws/credentials", "~/.ssh/id_rsa", "server.pem", "~/.ssh"]) expect(isSecretPath(p, posix), p).toBe(true);
    for (const p of [".env.example", ".env.sample", "~/.ssh/id_rsa.pub", "README.md", "env.ts"]) expect(isSecretPath(p, posix), p).toBe(false);
  });
});

describe("normalizer", () => {
  it.each([
    ['r""m -rf ~', "rm -rf ~"],
    ["rm${IFS}-rf${IFS}~", "rm -rf ~"],
    ["& ('Remove-'+'Item') -Recurse ~", "& Remove-Item -Recurse ~"],
    ["Re`move-Item -Recurse ~", "Remove-Item -Recurse ~"],
  ])("undoes %s", (input, plain) => {
    const n = normalizeCommand(input);
    expect(n.disguised).toBe(true);
    expect(n.variants.some((v) => v.replace(/["']/g, "") === plain)).toBe(true);
  });

  it("decodes base64 and PowerShell -EncodedCommand", () => {
    expect(normalizeCommand("echo cm0gLXJmIH4= | base64 -d | sh").decoded).toContain("rm -rf ~");
    const enc = Buffer.from("Get-Date", "utf16le").toString("base64");
    expect(normalizeCommand(`powershell -enc ${enc}`).decoded).toContain("Get-Date");
  });

  it("does not call plain commands disguised", () => {
    for (const c of ['git commit -m "it\'s fine"', 'echo "hello"', '"C:\\Program Files\\nodejs\\node.exe" app.js', "npm test"]) {
      expect(normalizeCommand(c).disguised, c).toBe(false);
    }
  });
});

describe("detectors", () => {
  it("finds live secrets but not documentation examples", () => {
    expect(findSecrets(`key ${FAKE_AWS_KEY}`).map((s) => s.type)).toEqual(["AWS_ACCESS_KEY"]);
    expect(findSecrets("key AKIAIOSFODNN7EXAMPLE and sk-xxxxxxxxxxxxxxxxxxxxxxxx")).toEqual([]);
  });

  it("redacts and rewrites", () => {
    expect(redactSecrets(`k=${FAKE_AWS_KEY}`)).toBe("k=[REDACTED:AWS_ACCESS_KEY]");
    expect(rewritePrompt(`use ${FAKE_AWS_KEY} and card 4111 1111 1111 1111`)).toBe("use $AWS_ACCESS_KEY_ID and card <CARD_NUMBER>");
  });

  it("checks card and Aadhaar checksums", () => {
    expect(findPII("4111 1111 1111 1111").map((p) => p.type)).toEqual(["CARD"]);
    expect(findPII("4111 1111 1111 1112")).toEqual([]);
    expect(findPII("2345 6789 0127").map((p) => p.type)).toEqual(["AADHAAR"]);
  });
});

describe("score", () => {
  it("follows the team guide formula", () => {
    expect(scoreOf([], false)).toBe(0);
    expect(scoreOf([hit("DES-001")], false)).toBe(85);
    expect(scoreOf([hit("SEC-004")], false)).toBe(50);
    expect(scoreOf([hit("SEC-004")], true)).toBe(65);
    expect(scoreOf([hit("DES-001"), hit("OBF-001")], true)).toBe(100);
    expect(levelOf(70)).toBe("SEVERE");
    expect(levelOf(69)).toBe("WARNING");
    expect(levelOf(35)).toBe("WARNING");
    expect(levelOf(34)).toBe("MILD");
    expect(levelOf(0)).toBe("CLEAN");
  });
});
