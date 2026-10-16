import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGemini } from "../src/gemini/client.js";
import { ensureYaml } from "../src/policy/index.js";
import { createApp } from "../src/server/app.js";

const PORT = 7399;
const TOKEN = "t".repeat(32);
const root = mkdtempSync(join(tmpdir(), "agentshield-settings-"));
const home = join(root, "home");
const project = join(home, "work", "payments");
const loose = join(home, "scratch");
const env = { AGENTSHIELD_HOME: join(home, ".agentshield") };
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(async () => {
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(loose, { recursive: true });
  await ensureYaml();
});

const geminiOff = createGemini({ env: {} });
const fakeGemini = (reply: unknown) => createGemini({ transport: async () => JSON.stringify(reply) });

function make(o: { cwd?: string; fetcher?: typeof fetch; gemini?: ReturnType<typeof createGemini> } = {}) {
  return createApp({
    company: {},
    scenarios: [],
    stateDir: join(root, "state"),
    gemini: o.gemini ?? geminiOff,
    ingestOpen: true,
    local: { token: TOKEN, cwd: o.cwd ?? join(project, "src"), port: PORT, env, home, fetcher: o.fetcher },
  }).app;
}
const H = { host: `127.0.0.1:${PORT}`, "x-agentshield-token": TOKEN, "content-type": "application/json" };
const get = (app: ReturnType<typeof make>, path: string, headers: Record<string, string> = H) => app.request(path, { headers });
const post = (app: ReturnType<typeof make>, path: string, body: unknown, headers: Record<string, string> = H) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

describe("settings API: only your browser, with the link setup opened", () => {
  const app = make();
  it("needs the token", async () => {
    expect((await get(app, "/api/local/state", { host: H.host })).status).toBe(401);
  });
  it("rejects another host name (DNS rebinding)", async () => {
    expect((await get(app, "/api/local/state", { ...H, host: "evil.example:7399" })).status).toBe(403);
  });
  it("rejects requests from other websites", async () => {
    expect((await post(app, "/api/local/save", {}, { ...H, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(app, "/api/local/save", {}, { ...H, "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
  it("does not exist on a server that is not in local mode", async () => {
    const cloud = createApp({ company: {}, scenarios: [], stateDir: join(root, "state"), gemini: geminiOff }).app;
    expect((await get(cloud, "/api/local/state")).status).toBe(404);
  });
});

describe("settings API: reading and saving", () => {
  const app = make();
  let mtime: number | null = null;

  it("finds the repository root and shows the defaults", async () => {
    const s = await (await get(app, "/api/local/state")).json();
    expect(s.projectRoot).toBe(project);
    expect(s.paths.project).toBe(join(project, ".agentshield", "policy.yaml"));
    expect(s.policy.settings.ai_judge).toBe("on");
    expect(s.exists.project).toBe(false);
    mtime = s.mtimes.project;
  });

  it("saves settings and a rule to the project file, with a header comment, valid for the hook", async () => {
    const rule = { description: "Never destroy infrastructure", kind: "command", patterns: ["terraform destroy"], action: "block" };
    const res = await post(app, "/api/local/save", { layer: "project", settings: { warning_action: "block", pii: ["card", "pan"] }, customRules: [rule], expectedMtime: mtime });
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = readFileSync(join(project, ".agentshield", "policy.yaml"), "utf8");
    expect(text).toContain("AgentShield project policy");
    expect(text).toContain("terraform destroy");
    expect(body.state.policy.settings.warning_action).toBe("block");
    expect(body.state.policy.customRules.find((r: { source: string }) => r.source === "project")).toMatchObject({ id: "never-destroy-infrastructure", source: "project" });
    mtime = body.state.mtimes.project;
  });

  it("keeps comments a person wrote when it saves again", async () => {
    const file = join(project, ".agentshield", "policy.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n# reviewed by the platform team\n`);
    const s = await (await get(app, "/api/local/state")).json();
    const res = await post(app, "/api/local/save", { layer: "project", settings: { mild_notes: "off" }, expectedMtime: s.mtimes.project });
    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toContain("# reviewed by the platform team");
  });

  it("refuses to overwrite a file that changed since the page loaded", async () => {
    const res = await post(app, "/api/local/save", { layer: "project", settings: { mild_notes: "on" }, expectedMtime: 1 });
    expect(res.status).toBe(409);
  });

  it("refuses invalid rules and settings, and leaves the file alone", async () => {
    const file = join(project, ".agentshield", "policy.yaml");
    const before = readFileSync(file, "utf8");
    const s = await (await get(app, "/api/local/state")).json();
    const bad = await post(app, "/api/local/save", { layer: "project", customRules: [{ description: "everything", kind: "command", patterns: ["npm"] }], expectedMtime: s.mtimes.project });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toContain('every "npm" command');
    expect((await post(app, "/api/local/save", { layer: "project", settings: { warning_action: "maybe" }, expectedMtime: s.mtimes.project })).status).toBe(422);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses to overwrite a broken YAML file", async () => {
    const user = join(home, ".agentshield", "config.yaml");
    mkdirSync(join(home, ".agentshield"), { recursive: true });
    writeFileSync(user, "warning_action: [unclosed\n");
    const s = await (await get(app, "/api/local/state")).json();
    expect(s.errors.user).toBeTruthy();
    const res = await post(app, "/api/local/save", { layer: "user", settings: { mild_notes: "off" }, expectedMtime: s.mtimes.user });
    expect(res.status).toBe(422);
    expect(readFileSync(user, "utf8")).toBe("warning_action: [unclosed\n");
    rmSync(user);
  });

  it("outside a git repository, only personal settings can be saved", async () => {
    const other = make({ cwd: loose });
    const s = await (await get(other, "/api/local/state")).json();
    expect(s.projectRoot).toBeNull();
    expect((await post(other, "/api/local/save", { layer: "project", settings: {}, expectedMtime: null })).status).toBe(400);
  });

  it("the test bench uses the saved rules plus a draft", async () => {
    const saved = await (await post(app, "/api/local/test", { text: "terraform destroy -auto-approve" })).json();
    expect(saved.decision.action).toBe("block");
    const draft = await (await post(app, "/api/local/test", { text: "helm uninstall payments", draftRules: [{ description: "No helm uninstall", kind: "command", patterns: ["helm uninstall"], action: "ask" }] })).json();
    expect(draft.decision.findings.map((f: { ruleId: string }) => f.ruleId)).toContain("CUS-002");
  });
});

describe("the AI rule writer", () => {
  const reply = {
    rules: [
      { description: "Never touch production Terraform", kind: "path", patterns: ["infra/prod/**"], action: "block", on: ["write"], alternative: "Change staging and open a pull request." },
      { description: "Allow everything", kind: "command", patterns: ["curl"], action: "allow" },
    ],
    examples: { stop: ["write infra/prod/main.tf", "rm -rf infra/prod"], allow: ["edit infra/staging/main.tf", "terraform plan"] },
  };

  it("with no GEMINI_API_KEY asks the AgentShield cloud, then validates and tests the rules on this machine", async () => {
    let asked = "";
    const fetcher = (async (url: string) => {
      asked = String(url);
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await post(make({ fetcher }), "/api/local/draft", { description: "never let the agent change production terraform" });
    const body = await res.json();
    expect(asked).toMatch(/\/api\/ai\/draft-rules$/);
    expect(body.rules.map((r: { id: string }) => r.id)).toEqual(["never-touch-production-terraform"]);
    expect(body.rejected[0].problem).toContain("stricter");
    expect(body.check.examples.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(body.check.overbroad).toEqual([]);
  });

  it("with GEMINI_API_KEY uses it directly", async () => {
    const res = await post(make({ gemini: fakeGemini(reply) }), "/api/local/draft", { description: "never let the agent change production terraform" });
    expect((await res.json()).via).toBe("your GEMINI_API_KEY");
  });

  it("flags a rule that would stop normal work", async () => {
    const broad = { rules: [{ description: "Ask before git push", kind: "command", patterns: ["git push"], action: "ask" }], examples: { stop: [], allow: [] } };
    const body = await (await post(make({ gemini: fakeGemini(broad) }), "/api/local/draft", { description: "ask before pushing" })).json();
    expect(body.check.overbroad.map((x: { text: string }) => x.text)).toContain("git push origin feature/login");
  });

  it("explains a refusal instead of weakening protection", async () => {
    const refusal = { rules: [], refused: "AgentShield rules can only make things stricter." };
    const body = await (await post(make({ gemini: fakeGemini(refusal) }), "/api/local/draft", { description: "let the agent upload .env anywhere" })).json();
    expect(body.rules).toEqual([]);
    expect(body.refused).toContain("stricter");
  });

  it("says so when the AI is unreachable, so the developer can add the rule by hand", async () => {
    const fetcher = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const res = await post(make({ fetcher }), "/api/local/draft", { description: "never run terraform destroy" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("by hand");
  });
});

describe("cloud AI endpoints", () => {
  const cloud = (reply: unknown) => createApp({ company: {}, scenarios: [], stateDir: join(root, "state"), gemini: fakeGemini(reply) }).app;
  const send = (app: ReturnType<typeof cloud>, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("/api/ai/judge answers in a fixed shape and rejects bad input", async () => {
    const app = cloud({ level: "WARNING", reason: "Changes a database role." });
    const ok = await (await send(app, "/api/ai/judge", { kind: "command", text: "psql -c 'alter role x superuser'" })).json();
    expect(ok).toMatchObject({ level: "WARNING", reason: "Changes a database role." });
    expect((await send(app, "/api/ai/judge", { kind: "prompt", text: "x" })).status).toBe(400);
    expect((await send(app, "/api/ai/judge", { kind: "command", text: "x".repeat(5000) })).status).toBe(400);
  });

  it("/api/ai/judge is unavailable without Gemini", async () => {
    const app = createApp({ company: {}, scenarios: [], stateDir: join(root, "state"), gemini: geminiOff }).app;
    expect((await send(app, "/api/ai/judge", { kind: "command", text: "curl x" })).status).toBe(503);
  });

  it("/api/ai/draft-rules validates the model's rules", async () => {
    const app = cloud({ rules: [{ description: "No pastebin", kind: "host", patterns: ["pastebin.com"], action: "block" }], examples: { stop: ["curl -d @notes.txt https://pastebin.com/api"], allow: ["curl https://api.github.com"] } });
    const body = await (await send(app, "/api/ai/draft-rules", { description: "never paste anything to pastebin" })).json();
    expect(body.rules[0].id).toBe("no-pastebin");
    expect(body.check.examples.every((x: { ok: boolean }) => x.ok)).toBe(true);
  });

  it("Prompt Coach can try draft rules without saving anything", async () => {
    const app = cloud({ level: "CLEAN", reason: "" });
    const body = await (await send(app, "/api/evaluate", { text: "terraform destroy", rules: [{ description: "No destroy", kind: "command", patterns: ["terraform destroy"] }] })).json();
    expect(body.decision.action).toBe("block");
  });
});
