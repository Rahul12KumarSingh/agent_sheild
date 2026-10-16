// Every adjustable setting, with a strictness order so the merge can tell tightening from loosening.
// Validation is hand-written (no schema library): the hook starts on every agent action, so start-up time matters.

import { GUARDRAIL_IDS } from "./guardrails.js";
import { type CustomRule, parseCustomRules, RuleError } from "./rules.js";

export const PII_PACKS = ["card", "aadhaar", "pan", "email"] as const;
export type PiiPack = (typeof PII_PACKS)[number];

export interface Settings {
  /** What a WARNING does when a human is present. */
  warning_action: "ask" | "block";
  /** What a tripped Rule of Two does. Never off. */
  rule_of_two: "ask" | "block";
  mild_notes: "on" | "off";
  coach_messages: "always" | "on_block" | "off";
  /** Reads outside the project folder: allowed, or asked (contractor posture). */
  outside_reads: "allow" | "ask";
  /** Known test data (test card numbers) is not flagged. Tester profile. */
  allow_test_data: boolean;
  /** Blocks in one session before everything except read-only tools is stopped. */
  circuit_breaker: number;
  /** Hosts that do not count as an "outside action" for the Rule of Two. */
  allowed_hosts: string[];
  /** Git remotes (host/owner prefix) where a push asks instead of blocks under the Rule of Two. */
  allowed_remotes: string[];
  /** MCP servers whose results do not mark the session as having read a stranger's text. */
  trusted_mcp_servers: string[];
  /** Extra secret paths (globs) on top of the built-in ones. */
  protected_paths: string[];
  /** Command prefixes that always need approval, e.g. "kubectl delete". */
  extra_ask_commands: string[];
  /** Personal data packs that are detected. */
  pii: PiiPack[];
  /** Gemini second opinion on risky-looking actions and web content: off, on (can ask a human), strict (can also block). */
  ai_judge: "off" | "on" | "strict";
  /** Ready-made guardrail packs that are switched off (all are on by default). */
  guardrails_off: string[];
}

export type SettingKey = keyof Settings;

type Spec =
  | { type: "enum"; order: readonly string[] }
  | { type: "bool"; strict: boolean }
  | { type: "number"; min: number; max: number }
  | { type: "list"; add: "tighten" | "loosen"; values?: readonly string[] };

/** Enum order runs loosest to strictest. Numbers: lower is stricter. */
export const SPEC: Record<SettingKey, Spec> = {
  warning_action: { type: "enum", order: ["ask", "block"] },
  rule_of_two: { type: "enum", order: ["ask", "block"] },
  mild_notes: { type: "enum", order: ["off", "on"] },
  coach_messages: { type: "enum", order: ["off", "on_block", "always"] },
  outside_reads: { type: "enum", order: ["allow", "ask"] },
  allow_test_data: { type: "bool", strict: false },
  circuit_breaker: { type: "number", min: 1, max: 20 },
  allowed_hosts: { type: "list", add: "loosen" },
  allowed_remotes: { type: "list", add: "loosen" },
  trusted_mcp_servers: { type: "list", add: "loosen" },
  protected_paths: { type: "list", add: "tighten" },
  extra_ask_commands: { type: "list", add: "tighten" },
  pii: { type: "list", add: "tighten", values: PII_PACKS },
  ai_judge: { type: "enum", order: ["off", "on", "strict"] },
  guardrails_off: { type: "list", add: "loosen", values: GUARDRAIL_IDS },
};

export const SETTING_KEYS = Object.keys(SPEC) as SettingKey[];

export const DESCRIPTIONS: Record<SettingKey, string> = {
  warning_action: "What a WARNING does when someone is there: ask a human, or block",
  rule_of_two: "What happens when a session holds a stranger's text, sensitive data and an outside action at once",
  mild_notes: "Show small notes for MILD findings",
  coach_messages: "When to show the safer alternative: always, only on a block, or off",
  outside_reads: "Reading files outside the project folder: allow, or ask first",
  allow_test_data: "Known test data (for example test card numbers) is not flagged",
  circuit_breaker: "Blocks in one session before only read-only tools are allowed",
  allowed_hosts: "Hosts that are not an outside action for the Rule of Two",
  allowed_remotes: "Git remotes where a push asks instead of blocks under the Rule of Two",
  trusted_mcp_servers: "MCP servers whose results are not treated as a stranger's text",
  protected_paths: "Extra secret files and folders (globs)",
  extra_ask_commands: "Commands that always need approval",
  pii: "Personal data packs that are detected",
  ai_judge: "AI review of risky-looking commands and web content: off, on (asks you), strict (can block)",
  guardrails_off: "Ready-made guardrail packs that are switched off",
};

export interface ProfileDef extends Partial<Settings> {
  /** Higher is stricter. A user may only switch to a profile with a higher rank. */
  rank: number;
  description?: string;
  locked?: SettingKey[];
}

/** One file: company policy, project policy or personal config. */
export interface PolicyFile extends Partial<Settings> {
  version?: 1;
  name?: string;
  mode?: "enforce" | "monitor";
  profile?: string;
  console_url?: string;
  /** Where the AI judge and the rule writer send requests when no GEMINI_API_KEY is set. Company or personal only. */
  ai_endpoint?: string;
  /** The team's or developer's own block / ask rules. Only ever added to, never removed by a lower layer. */
  custom_rules?: CustomRule[];
  locked?: SettingKey[];
  profiles?: Record<string, ProfileDef>;
}

export class SchemaError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const PII_ENTRY = /^!?(card|aadhaar|pan|email)$/;

/** Validate one setting value. Returns the normalised value or throws SchemaError. */
export function parseSetting(key: SettingKey, value: unknown, path: string = key): unknown {
  const spec = SPEC[key];
  switch (spec.type) {
    case "enum": {
      // YAML 1.1 habit: `on` / `off` may arrive as booleans.
      const v = key === "mild_notes" && typeof value === "boolean" ? (value ? "on" : "off") : value;
      if (typeof v !== "string" || !spec.order.includes(v)) throw new SchemaError(path, `expected one of ${spec.order.join(", ")}`);
      return v;
    }
    case "bool":
      if (typeof value !== "boolean") throw new SchemaError(path, "expected true or false");
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) {
        throw new SchemaError(path, `expected a whole number from ${spec.min} to ${spec.max}`);
      }
      return value;
    case "list": {
      if (!Array.isArray(value)) throw new SchemaError(path, "expected a list");
      if (value.length > 200) throw new SchemaError(path, "too many entries (max 200)");
      return value.map((e, i) => {
        if (typeof e !== "string" || e.trim() === "" || e.length > 200) throw new SchemaError(`${path}.${i}`, "expected a short text");
        if (key === "pii" && !PII_ENTRY.test(e)) throw new SchemaError(`${path}.${i}`, "expected card, aadhaar, pan or email");
        if (key === "guardrails_off" && !GUARDRAIL_IDS.includes(e.replace(/^!/, ""))) throw new SchemaError(`${path}.${i}`, `expected one of ${GUARDRAIL_IDS.join(", ")}`);
        return e;
      });
    }
  }
}

function parseLocked(value: unknown, path: string): SettingKey[] {
  if (!Array.isArray(value)) throw new SchemaError(path, "expected a list of setting names");
  return value.map((k, i) => {
    if (typeof k !== "string" || !(SETTING_KEYS as string[]).includes(k)) throw new SchemaError(`${path}.${i}`, `unknown setting "${String(k)}"`);
    return k as SettingKey;
  });
}

function parseSettingsInto(out: Record<string, unknown>, raw: Record<string, unknown>, key: string, path: string): boolean {
  if (!(SETTING_KEYS as string[]).includes(key)) return false;
  out[key] = parseSetting(key as SettingKey, raw[key], path);
  return true;
}

function parseProfile(raw: unknown, path: string): ProfileDef {
  if (!isObj(raw)) throw new SchemaError(path, "expected a mapping");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const p = `${path}.${key}`;
    if (parseSettingsInto(out, raw, key, p)) continue;
    if (key === "rank") {
      const r = raw.rank;
      if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r > 10) throw new SchemaError(p, "expected a whole number from 0 to 10");
      out.rank = r;
    } else if (key === "description") {
      if (typeof raw.description !== "string") throw new SchemaError(p, "expected text");
      out.description = raw.description.slice(0, 300);
    } else if (key === "locked") out.locked = parseLocked(raw.locked, p);
    else throw new SchemaError(p, "unknown key");
  }
  if (typeof out.rank !== "number") throw new SchemaError(`${path}.rank`, "required");
  return out as unknown as ProfileDef;
}

/** Validate a whole policy file. Unknown keys are errors, so a typo fails closed instead of being ignored. */
export function parsePolicyFile(raw: unknown): PolicyFile {
  if (raw === null || raw === undefined) return {};
  if (!isObj(raw)) throw new SchemaError("(file)", "expected a mapping of settings");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (parseSettingsInto(out, raw, key, key)) continue;
    switch (key) {
      case "version":
        if (v !== 1) throw new SchemaError(key, "expected 1");
        out.version = 1;
        break;
      case "name":
        if (typeof v !== "string" || v.length > 100) throw new SchemaError(key, "expected a short text");
        out.name = v;
        break;
      case "mode":
        if (v !== "enforce" && v !== "monitor") throw new SchemaError(key, "expected enforce or monitor");
        out.mode = v;
        break;
      case "profile":
        if (typeof v !== "string" || !/^[a-z][a-z0-9_-]{0,30}$/.test(v)) throw new SchemaError(key, "expected a profile name");
        out.profile = v;
        break;
      case "console_url":
      case "ai_endpoint":
        if (typeof v !== "string" || !/^https?:\/\/[^\s]+$/.test(v)) throw new SchemaError(key, "expected an http or https URL");
        out[key] = v.replace(/\/+$/, "");
        break;
      case "custom_rules":
        try {
          out.custom_rules = parseCustomRules(v, key);
        } catch (err) {
          if (err instanceof RuleError) throw new SchemaError(err.path, err.message.slice(err.path.length + 2));
          throw err;
        }
        break;
      case "locked":
        out.locked = parseLocked(v, key);
        break;
      case "profiles": {
        if (!isObj(v)) throw new SchemaError(key, "expected a mapping of profile names");
        const profiles: Record<string, ProfileDef> = {};
        for (const name of Object.keys(v)) {
          if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name)) throw new SchemaError(`${key}.${name}`, "profile names use lowercase letters, digits, - and _");
          profiles[name] = parseProfile(v[name], `${key}.${name}`);
        }
        out.profiles = profiles;
        break;
      }
      default:
        throw new SchemaError(key, "unknown key");
    }
  }
  return out as PolicyFile;
}

/** Parse a value typed on the command line into the setting's type. */
export function parseCliValue(key: SettingKey, raw: string): unknown {
  const spec = SPEC[key];
  if (spec.type === "bool") return raw === "true" || raw === "on" || raw === "yes" ? true : raw === "false" || raw === "off" || raw === "no" ? false : raw;
  if (spec.type === "number") return /^\d+$/.test(raw) ? Number(raw) : raw;
  if (spec.type === "list") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}
