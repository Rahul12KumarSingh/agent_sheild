// Custom rules: a team's or a developer's own "block this" / "ask before this", written by hand,
// in the settings page, or drafted by Gemini from plain English. They can only make AgentShield stricter:
// there is no "allow" rule, and a lower layer can never remove a rule a higher layer added.

export const RULE_KINDS = ["command", "path", "host", "text"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface CustomRule {
  /** Short stable id, lowercase with dashes. Derived from the description when missing. */
  id: string;
  /** One sentence the developer reads in the block message. */
  description: string;
  kind: RuleKind;
  /**
   * command: command prefixes ("terraform destroy", "kubectl delete ns").
   * path:    file globs ("infra/prod/**", "*.tfstate").
   * host:    host globs ("*.internal.example", "pastebin.com").
   * text:    case-insensitive regular expressions matched on commands and prompts.
   */
  patterns: string[];
  action: "block" | "ask";
  /** For path rules: which operations count. Default both. */
  on?: ("read" | "write")[];
  /** What to do instead, shown with the block. */
  alternative?: string;
}

export class RuleError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** "Never destroy infrastructure from an agent" -> "never-destroy-infrastructure-from-an" (whole words, max 40). */
export const slugify = (s: string) => {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > 40) break;
    out = next;
  }
  return out || words[0]?.slice(0, 40) || "rule";
};

/** Patterns so broad that they would stop normal work, whatever the description says. */
function tooBroad(kind: RuleKind, p: string): string | undefined {
  const t = p.trim();
  if (kind === "command" && /^[\w.-]+$/.test(t) && ["git", "npm", "node", "python", "python3", "ls", "cat", "cd", "echo", "npx", "pnpm", "yarn", "pip", "go", "cargo", "make", "bash", "sh"].includes(t.toLowerCase())) {
    return `would stop every "${t}" command; name the risky part, for example "${t} publish" or "${t} push --force"`;
  }
  if (kind === "path" && /^[\\/*.~]*$/.test(t)) return "would match every file";
  if (kind === "host" && /^[*.]*$/.test(t)) return "would match every website";
  if (kind === "host" && /^\*\.[a-z]{2,}$/i.test(t)) return "would match a whole top-level domain";
  if (kind === "text" && /^(\.\*|\.\+|\\w\+?|\\s\*?|\^|\$)*$/.test(t)) return "would match any text";
  if (t.length < 2) return "is too short";
  return undefined;
}

/**
 * A regular expression we are willing to run on every command: compiles, short, and without the
 * nested-quantifier shapes that can make matching take forever (ReDoS).
 */
export function checkRegex(p: string): string | undefined {
  if (p.length > 200) return "is longer than 200 characters";
  if (/\\[1-9]|\\k</.test(p)) return "uses back-references";
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(p)) return "has a nested repeat like (a+)+, which can be very slow";
  if (/(?:\.\*){2,}|(?:\.\+){2,}/.test(p.replace(/\s/g, ""))) return "has repeated wildcards (.*.*), which can be very slow";
  try {
    new RegExp(p, "i");
  } catch (err) {
    return `is not a valid regular expression (${err instanceof Error ? err.message : "error"})`;
  }
  return undefined;
}

/** Validate one rule. Returns the normalised rule or throws RuleError with a message a person can act on. */
export function parseCustomRule(raw: unknown, path = "custom_rules.0"): CustomRule {
  if (!isObj(raw)) throw new RuleError(path, "expected a mapping with description, kind, patterns and action");
  for (const key of Object.keys(raw)) {
    if (!["id", "description", "kind", "patterns", "action", "on", "alternative"].includes(key)) throw new RuleError(`${path}.${key}`, "unknown key");
  }
  const description = typeof raw.description === "string" ? raw.description.replace(/\s+/g, " ").trim() : "";
  if (description.length < 3 || description.length > 200) throw new RuleError(`${path}.description`, "expected one sentence (3 to 200 characters)");

  const kind = raw.kind;
  if (typeof kind !== "string" || !(RULE_KINDS as readonly string[]).includes(kind)) throw new RuleError(`${path}.kind`, `expected one of ${RULE_KINDS.join(", ")}`);

  const action = raw.action ?? "block";
  if (action !== "block" && action !== "ask") throw new RuleError(`${path}.action`, 'expected "block" or "ask" (rules can only make AgentShield stricter)');

  if (!Array.isArray(raw.patterns) || raw.patterns.length === 0) throw new RuleError(`${path}.patterns`, "expected a list with at least one pattern");
  if (raw.patterns.length > 20) throw new RuleError(`${path}.patterns`, "too many patterns (max 20)");
  const patterns = raw.patterns.map((p, i) => {
    const where = `${path}.patterns.${i}`;
    if (typeof p !== "string" || !p.trim() || p.length > 200) throw new RuleError(where, "expected a short text");
    let v = p.trim();
    if (kind === "command") v = v.toLowerCase().replace(/\s+/g, " ");
    if (kind === "host") v = v.toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
    const broad = tooBroad(kind as RuleKind, v);
    if (broad) throw new RuleError(where, `"${v}" ${broad}`);
    if (kind === "text") {
      const bad = checkRegex(v);
      if (bad) throw new RuleError(where, `"${v}" ${bad}`);
    }
    if (kind === "host" && !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) throw new RuleError(where, `"${v}" is not a host name like example.com or *.example.com`);
    return v;
  });

  let on: CustomRule["on"];
  if (raw.on !== undefined) {
    if (kind !== "path") throw new RuleError(`${path}.on`, "only path rules take on: [read, write]");
    if (!Array.isArray(raw.on) || raw.on.length === 0 || raw.on.some((o) => o !== "read" && o !== "write")) throw new RuleError(`${path}.on`, "expected [read], [write] or [read, write]");
    on = [...new Set(raw.on as ("read" | "write")[])];
  }

  let alternative: string | undefined;
  if (raw.alternative !== undefined) {
    if (typeof raw.alternative !== "string" || raw.alternative.length > 300) throw new RuleError(`${path}.alternative`, "expected one sentence (max 300 characters)");
    alternative = raw.alternative.trim() || undefined;
  }

  let id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : slugify(description);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new RuleError(`${path}.id`, "use lowercase letters, digits and dashes (max 40)");
  id = id.replace(/-+$/, "");

  return { id, description, kind: kind as RuleKind, patterns: [...new Set(patterns)], action, ...(on ? { on } : {}), ...(alternative ? { alternative } : {}) };
}

export function parseCustomRules(raw: unknown, path = "custom_rules"): CustomRule[] {
  if (!Array.isArray(raw)) throw new RuleError(path, "expected a list of rules");
  if (raw.length > 100) throw new RuleError(path, "too many rules (max 100)");
  const rules = raw.map((r, i) => parseCustomRule(r, `${path}.${i}`));
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new RuleError(path, `two rules share the id "${r.id}"`);
    seen.add(r.id);
  }
  return rules;
}

/** One line a person can read: "Block commands starting with terraform destroy". */
export function describeRule(r: CustomRule): string {
  const verb = r.action === "block" ? "Block" : "Ask before";
  const list = r.patterns.map((p) => `"${p}"`).join(", ");
  switch (r.kind) {
    case "command":
      return `${verb} commands starting with ${list}`;
    case "path":
      return `${verb} ${r.on?.length === 1 ? (r.on[0] === "read" ? "reading" : "changing") : "reading or changing"} files matching ${list}`;
    case "host":
      return `${verb} anything that contacts ${list}`;
    case "text":
      return `${verb} commands or prompts matching ${list}`;
  }
}
