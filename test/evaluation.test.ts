import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { decide, newSession } from "../src/engine/index.js";
import type { Level, ShieldEvent } from "../src/engine/types.js";
import { loadScenarios } from "../src/server/scenarios.js";
import { b64, cmd, POSIX, ps, psEncoded, run } from "./helpers.js";

// The evaluation table: measured, not claimed. `npm run eval` writes docs/EVALUATION.md from this file.

const ROOT = join(import.meta.dirname, "..");
const RANK: Record<Level, number> = { CLEAN: 0, MILD: 1, WARNING: 2, SEVERE: 3 };

interface Case {
  id: string;
  note: string;
  expect: Level;
  bash?: string;
  ps?: string;
  [k: string]: unknown;
}
const load = (n: string) => JSON.parse(readFileSync(join(ROOT, "test", "corpus", n), "utf8")) as Case[];
const attacks = load("attack.json");
const benign = load("benign.json");

// ---------- Mutations: the same attack, written the way an attacker would disguise it ----------

type Mutation = { name: string; apply: (c: string) => string | undefined };

const firstWord = (c: string) => /^(\S+)(\s.*)?$/s.exec(c.trim());
// A word that is already disguised is left alone: adding another escape would change what runs (r\\m is not rm).
const plainWord = (w: string) => /^[a-z][a-z0-9._-]+$/.test(w);
const BASH_MUTATIONS: Mutation[] = [
  { name: "empty quotes in the command word", apply: (c) => { const m = firstWord(c); return m && plainWord(m[1]!) ? `${m[1]![0]}""${m[1]!.slice(1)}${m[2] ?? ""}` : undefined; } },
  { name: "backslash in the command word", apply: (c) => { const m = firstWord(c); return m && plainWord(m[1]!) ? `${m[1]![0]}\\${m[1]!.slice(1)}${m[2] ?? ""}` : undefined; } },
  { name: "$IFS instead of spaces", apply: (c) => (c.includes("'") || c.includes('"') ? undefined : c.replace(/ /g, "${IFS}")) },
  { name: "wrapped in bash -c", apply: (c) => (c.includes('"') ? undefined : `bash -c "${c}"`) },
  { name: "sudo prefix", apply: (c) => (c.startsWith("sudo ") ? undefined : `sudo ${c}`) },
  { name: "env assignment prefix", apply: (c) => `LANG=C ${c}` },
  { name: "base64 piped into sh", apply: (c) => `echo ${b64(c)} | base64 -d | sh` },
];
const PS_MUTATIONS: Mutation[] = [
  { name: "backtick in the cmdlet name", apply: (c) => { const m = /^([A-Z][a-z]+)-([A-Z][A-Za-z]+)(.*)$/s.exec(c); return m ? `${m[1]![0]}${m[1]!.slice(1, 2)}\`${m[1]!.slice(2)}-${m[2]}${m[3]}` : undefined; } },
  { name: "string concatenation and the call operator", apply: (c) => { const m = /^([A-Z][a-z]+-)([A-Z][A-Za-z]+)(.*)$/s.exec(c); return m ? `& ('${m[1]}'+'${m[2]}')${m[3]}` : undefined; } },
  { name: "-EncodedCommand", apply: (c) => `powershell -NoProfile -EncodedCommand ${psEncoded(c)}` },
];

interface MutResult {
  id: string;
  mutation: string;
  text: string;
  got: Level;
  want: Level;
  ok: boolean;
}

function mutationResults(): MutResult[] {
  const out: MutResult[] = [];
  for (const c of attacks) {
    const source = c.bash ?? c.ps;
    if (!source) continue;
    for (const m of c.bash ? BASH_MUTATIONS : PS_MUTATIONS) {
      const text = m.apply(source);
      if (!text || text === source) continue;
      const d = run(c.bash ? cmd(text) : ps(text));
      out.push({ id: c.id, mutation: m.name, text, got: d.level, want: c.expect, ok: RANK[d.level] >= RANK[c.expect] });
    }
  }
  return out;
}

function toEvent(c: Case): ShieldEvent {
  const base = { agent: "claude" as const, sessionId: "eval", cwd: "/home/dev/project", headless: false };
  if (c.bash !== undefined) return cmd(c.bash);
  if (c.ps !== undefined) return ps(c.ps);
  if (typeof c.prompt === "string") return { ...base, kind: "prompt", text: c.prompt };
  if (typeof c.read === "string") return { ...base, kind: "action", tool: "Read", input: { file_path: c.read } };
  if (typeof c.fetch === "string") return { ...base, kind: "action", tool: "WebFetch", input: { url: c.fetch } };
  if (Array.isArray(c.write)) return { ...base, kind: "action", tool: "Write", input: { file_path: c.write[0], content: c.write[1] } };
  if (c.edit !== undefined) {
    const [file_path, new_string] = Array.isArray(c.edit) ? c.edit : [c.edit, "x"];
    return { ...base, kind: "action", tool: "Edit", input: { file_path, old_string: "y", new_string } };
  }
  if (Array.isArray(c.result)) return { ...base, kind: "result", tool: c.result[0], input: {}, output: String(c.result[1]).replace(/\{\{TAGS:(.*?)\}\}/g, (_, t: string) => [...t].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join("")) };
  if (Array.isArray(c.mcp)) return { ...base, kind: "action", tool: c.mcp[0], input: c.mcp[1] };
  throw new Error(`no event for ${c.id}`);
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

describe("evaluation", () => {
  const attackResults = attacks.map((c) => {
    const d = run(toEvent(c));
    return { c, d, ok: RANK[d.level] >= RANK[c.expect] };
  });
  const benignResults = benign.map((c) => ({ c, d: run(toEvent(c)) }));
  const mutations = mutationResults();

  it("attack corpus: every case reaches its expected level", () => {
    expect(attackResults.filter((r) => !r.ok).map((r) => r.c.id)).toEqual([]);
  });

  it("benign corpus: zero blocks and zero asks", () => {
    expect(benignResults.filter((r) => r.d.action === "block" || r.d.action === "ask").map((r) => r.c.id)).toEqual([]);
  });

  it("mutated attacks: at least 90 percent still reach their expected level", () => {
    const rate = mutations.filter((m) => m.ok).length / mutations.length;
    expect(mutations.length).toBeGreaterThan(100);
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it.runIf(process.env.AGENTSHIELD_WRITE_EVAL === "1")("writes docs/EVALUATION.md", () => {
    // Engine latency, in process.
    const events = [...attacks, ...benign].map(toEvent);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) for (const e of events) {
      const t0 = performance.now();
      decide(e, POSIX, { session: newSession("lat") });
      times.push(performance.now() - t0);
    }
    // Hook end to end, spawned like an agent app does it (needs a build).
    const bench = spawnSync(process.execPath, [join(ROOT, "scripts", "bench-hook.mjs"), "60"], { encoding: "utf8" });
    const hookLine = /hook end to end over \d+ calls: p50 (\d+) ms, p95 (\d+) ms/.exec(bench.stdout ?? "");
    const nodeLine = /node start-up alone: p50 (\d+) ms/.exec(bench.stdout ?? "");
    const scenarios = loadScenarios(join(ROOT, "scenarios"));
    const commit = (() => {
      try {
        return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();
    const misses = mutations.filter((m) => !m.ok);
    const byMutation = new Map<string, { n: number; ok: number }>();
    for (const m of mutations) {
      const x = byMutation.get(m.mutation) ?? { n: 0, ok: 0 };
      x.n++;
      if (m.ok) x.ok++;
      byMutation.set(m.mutation, x);
    }
    const byCat = new Map<string, { n: number; ok: number }>();
    for (const r of attackResults) {
      const cat = r.d.findings[0]?.category ?? "none";
      const x = byCat.get(cat) ?? { n: 0, ok: 0 };
      x.n++;
      if (r.ok) x.ok++;
      byCat.set(cat, x);
    }
    const percent = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
    const md = [
      "# AgentShield evaluation",
      "",
      `Measured on ${new Date().toISOString().slice(0, 10)} at commit \`${commit}\` (Node ${process.versions.node}, ${platform()} ${release()} ${arch()}). Regenerate with \`npm run build && npm run eval\`.`,
      "",
      "These numbers are for **our own test set**, written by the team. They are not a claim about unseen attacks. The Rule of Two exists because detection will miss things.",
      "",
      "| Measure | Result |",
      "|---|---|",
      `| Attack corpus: cases that reach their expected level | **${attackResults.filter((r) => r.ok).length} / ${attackResults.length}** (${percent(attackResults.filter((r) => r.ok).length, attackResults.length)}) |`,
      `| Mutated attacks (generated disguises of the shell attacks) | **${mutations.length - misses.length} / ${mutations.length}** (${percent(mutations.length - misses.length, mutations.length)}) |`,
      `| Benign corpus: blocks | **${benignResults.filter((r) => r.d.action === "block").length} / ${benignResults.length}** (must be 0) |`,
      `| Benign corpus: asks | **${benignResults.filter((r) => r.d.action === "ask").length} / ${benignResults.length}** (must be 0) |`,
      `| Scenarios S1 to S10 matching their expected result | **${scenarios.length} / ${scenarios.length}** (asserted in \`test/server.test.ts\`) |`,
      `| Engine latency, in process | p50 ${pct(times, 0.5).toFixed(2)} ms, p95 ${pct(times, 0.95).toFixed(2)} ms over ${times.length} evaluations |`,
      hookLine
        ? `| Hook end to end, spawned like an agent app | p50 ${hookLine[1]} ms, p95 ${hookLine[2]} ms (of which Node start-up alone: ${nodeLine?.[1] ?? "?"} ms on this machine) |`
        : "| Hook end to end | not measured (run `npm run build` first) |",
      "",
      "## Attack corpus by category (top finding)",
      "",
      "| Category | Reached expected level |",
      "|---|---|",
      ...[...byCat.entries()].sort().map(([k, v]) => `| ${k} | ${v.ok} / ${v.n} |`),
      "",
      "## Mutations",
      "",
      "Each Bash attack in the corpus is rewritten with every Bash disguise below, and each PowerShell attack with every PowerShell disguise, where the disguise applies. The mutated command must still reach the level of the original.",
      "",
      "| Disguise | Still caught |",
      "|---|---|",
      ...[...byMutation.entries()].map(([k, v]) => `| ${k} | ${v.ok} / ${v.n} |`),
      "",
      misses.length ? "### Misses (shown on purpose)" : "No mutated attack fell below its expected level.",
      "",
      ...misses.map((m) => `- ${m.id}, ${m.mutation}: got ${m.got}, expected ${m.want}. \`${m.text.slice(0, 120).replace(/`/g, "'")}\``),
      "",
      "## Known limits",
      "",
      "- Rules see text, not meaning. New disguises and non-English instructions can be missed; the Rule of Two and the optional Gemini judge (raise-only) are the backstops.",
      "- Leaks through allowed places (an allowed host, an issue comment, a gist on an allowed account) are only caught when the Rule of Two applies.",
      "- Images are not scanned.",
      "- On unmanaged machines a user can remove the hooks. Use the agent vendor's managed settings for enforcement.",
      "- Claude Code keeps a blocked prompt in its local transcript. Rotate any key that was pasted.",
      "",
    ].join("\n");
    writeFileSync(join(ROOT, "docs", "EVALUATION.md"), md);
    console.log(md);
  }, 120_000);
});
