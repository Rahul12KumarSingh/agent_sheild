import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import type { Level, ShieldEvent } from "../src/engine/types.js";
import { cmd, edit, fetchUrl, mcp, prompt, ps, read, result, run, tags, write } from "./helpers.js";

interface Case {
  id: string;
  note: string;
  expect: Level;
  bash?: string;
  ps?: string;
  read?: string;
  write?: [string, string];
  edit?: string | [string, string];
  fetch?: string;
  prompt?: string;
  result?: [string, string];
  mcp?: [string, Record<string, unknown>];
}

const RANK: Record<Level, number> = { CLEAN: 0, MILD: 1, WARNING: 2, SEVERE: 3 };
const expandTags = (s: string) => s.replace(/\{\{TAGS:(.*?)\}\}/g, (_, t: string) => tags(t));

function toEvent(c: Case): ShieldEvent {
  if (c.bash !== undefined) return cmd(c.bash);
  if (c.ps !== undefined) return ps(c.ps);
  if (c.read !== undefined) return read(c.read);
  if (c.write) return write(c.write[0], c.write[1]);
  if (c.edit) return Array.isArray(c.edit) ? edit(c.edit[0], c.edit[1]) : edit(c.edit);
  if (c.fetch !== undefined) return fetchUrl(c.fetch);
  if (c.prompt !== undefined) return prompt(c.prompt);
  if (c.result) return result(c.result[0], expandTags(c.result[1]));
  if (c.mcp) return mcp(c.mcp[0], c.mcp[1]);
  throw new Error(`Case ${c.id} has no event`);
}

const load = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "corpus", name), "utf8")) as Case[];
const attacks = load("attack.json");
const benign = load("benign.json");
const misses: string[] = [];

describe("attack corpus: every case reaches at least its expected level", () => {
  it.each(attacks.map((c) => [`${c.id} ${c.note}`, c] as const))("%s", (_, c) => {
    const d = run(toEvent(c));
    if (RANK[d.level] < RANK[c.expect]) misses.push(`${c.id} got ${d.level}, expected ${c.expect}`);
    expect(RANK[d.level], `${c.id}: ${d.level} ${d.findings.map((f) => f.ruleId).join(",")}`).toBeGreaterThanOrEqual(RANK[c.expect]);
    if (d.action === "block") expect(d.safeAlternative, "every block carries a safe alternative").toBeTruthy();
  });
});

describe("benign corpus: zero blocks and zero asks (hard gate)", () => {
  it.each(benign.map((c) => [`${c.id} ${c.note}`, c] as const))("%s", (_, c) => {
    const d = run(toEvent(c));
    expect(["block", "ask"], `${c.id}: ${d.action} ${d.findings.map((f) => f.ruleId).join(",")}`).not.toContain(d.action);
    expect(RANK[d.level], `${c.id}: ${d.level} ${d.findings.map((f) => f.ruleId).join(",")}`).toBeLessThanOrEqual(RANK[c.expect]);
  });
});

describe("speed", () => {
  it("engine p95 is under 20 ms per event", () => {
    const events = [...attacks, ...benign].map(toEvent);
    const times: number[] = [];
    for (let round = 0; round < 20; round++) {
      for (const e of events) {
        const t0 = performance.now();
        run(e);
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`engine latency over ${times.length} evaluations: p50=${times[Math.floor(times.length / 2)]!.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(20);
  });
});

afterAll(() => {
  const hit = attacks.length - misses.length;
  console.log(`attack hit rate: ${hit}/${attacks.length}${misses.length ? ` (misses: ${misses.join("; ")})` : ""}. benign cases: ${benign.length}`);
});
