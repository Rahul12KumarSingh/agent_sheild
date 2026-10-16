import type { CustomRule } from "../policy/rules.js";
import { clip, hit } from "./catalog.js";
import { redactSecrets } from "./detectors.js";
import { normalizeCommand } from "./normalize.js";
import { parseSegments, segmentHosts, urlHosts } from "./commands.js";
import { compileProtectedPaths, type PathContext, resolvePath } from "./paths.js";
import type { Finding } from "./types.js";

// The team's own rules from the policy (custom_rules), applied to every kind of event.
// A rule only ever adds a finding: CUS-001 blocks, CUS-002 asks.

export interface CustomInput {
  kind: "command" | "read" | "search" | "write" | "fetch" | "other" | "prompt";
  command?: string;
  filePath?: string;
  /** Text the event sends or writes: prompt text, written content, a tool's JSON input. */
  text?: string;
}

const compiledText = new WeakMap<CustomRule, RegExp[]>();
const textRegexes = (r: CustomRule) => {
  let res = compiledText.get(r);
  if (!res) {
    res = r.patterns.flatMap((p) => {
      try {
        return [new RegExp(p, "i")];
      } catch {
        return [];
      }
    });
    compiledText.set(r, res);
  }
  return res;
};

const hostMatches = (host: string, pattern: string) => {
  const base = pattern.replace(/^\*\./, "");
  return host === base || host.endsWith(`.${base}`);
};

function pathMatches(raw: string, r: CustomRule, ctx: PathContext): boolean {
  const res = compileProtectedPaths(r.patterns, ctx);
  const p = resolvePath(raw, ctx).toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  return res.some((re) => re.test(p) || re.test(base));
}

function commandLines(command: string): string[] {
  const lines = new Set<string>();
  for (const variant of normalizeCommand(command).variants) {
    for (const s of parseSegments(variant)) if (s.cmd) lines.add([s.cmd, ...s.args].join(" ").toLowerCase().replace(/\s+/g, " "));
  }
  return [...lines];
}

function matchRule(r: CustomRule, input: CustomInput, ctx: PathContext): string | undefined {
  const command = input.command;
  switch (r.kind) {
    case "command": {
      if (!command) return undefined;
      const lines = commandLines(command);
      // A prefix ends at a word boundary: "kubectl apply -f k8s/prod" matches ".../prod/web.yaml", not ".../production".
      return r.patterns.find((p) => lines.some((l) => l.startsWith(p) && (l.length === p.length || /[\s/=:]/.test(l[p.length]!) || /[/=:]$/.test(p))));
    }
    case "path": {
      const ops = r.on ?? ["read", "write"];
      if (input.filePath) {
        const op = input.kind === "write" ? "write" : input.kind === "read" || input.kind === "search" ? "read" : undefined;
        if (op && ops.includes(op) && pathMatches(input.filePath, r, ctx)) return input.filePath;
      }
      if (command) {
        for (const variant of normalizeCommand(command).variants) {
          for (const s of parseSegments(variant)) {
            const hitPath = [...s.positional, ...s.redirectsOut, ...s.redirectsIn].find((t) => !/^https?:/i.test(t) && pathMatches(t, r, ctx));
            if (hitPath) return hitPath;
          }
        }
      }
      return undefined;
    }
    case "host": {
      const hosts = new Set<string>();
      if (command) {
        for (const variant of normalizeCommand(command).variants) {
          for (const h of urlHosts(variant)) hosts.add(h);
          for (const s of parseSegments(variant)) for (const h of segmentHosts(s)) hosts.add(h);
        }
      }
      if (input.text && input.kind !== "prompt") for (const h of urlHosts(input.text)) hosts.add(h);
      for (const h of hosts) if (r.patterns.some((p) => hostMatches(h, p))) return h;
      return undefined;
    }
    case "text": {
      const texts = [command, input.text].filter((t): t is string => Boolean(t)).map((t) => t.slice(0, 20_000));
      const re = textRegexes(r).find((x) => texts.some((t) => x.test(t)));
      return re ? re.source : undefined;
    }
  }
}

export function customRuleFindings(rules: readonly (CustomRule & { source?: string; pack?: string })[], input: CustomInput, ctx: PathContext): Finding[] {
  const out: Finding[] = [];
  for (const r of rules) {
    const matched = matchRule(r, input, ctx);
    if (!matched) continue;
    const guardrail = r.source === "guardrail";
    const from = guardrail ? `, guardrail "${r.pack ?? r.id}"` : r.source ? `, ${r.source} rule "${r.id}"` : `, rule "${r.id}"`;
    const id = guardrail ? (r.action === "block" ? "GRD-001" : "GRD-002") : r.action === "block" ? "CUS-001" : "CUS-002";
    const f = hit(id, `${r.description} (matched ${clip(redactSecrets(matched), 60)}${from})`);
    out.push(r.alternative ? { ...f, alternative: r.alternative } : f);
  }
  return out;
}
