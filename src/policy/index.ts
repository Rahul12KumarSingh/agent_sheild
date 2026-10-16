import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { guardrailRules } from "./guardrails.js";
import type { CustomRule } from "./rules.js";
import {
  parsePolicyFile,
  type PolicyFile,
  type ProfileDef,
  SchemaError,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
  SPEC,
} from "./settings.js";

export * from "./guardrails.js";
export * from "./rules.js";
export * from "./settings.js";

// Four layers, strictest wins: company -> role profile -> project -> personal.
// A lower layer can always tighten. It can loosen only what no higher layer locked.

/** Used when no company policy is installed. The always-on protections live in the engine code itself. */
export const BUILTIN: PolicyFile = {
  name: "AgentShield default",
  mode: "enforce",
  warning_action: "ask",
  rule_of_two: "block",
  mild_notes: "on",
  coach_messages: "always",
  outside_reads: "allow",
  approvals: "saved",
  allow_test_data: false,
  circuit_breaker: 3,
  allowed_hosts: [
    "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "nodejs.org",
    "developer.mozilla.org", "docs.python.org", "learn.microsoft.com", "docs.github.com",
  ],
  allowed_remotes: [],
  trusted_mcp_servers: ["agentshield", "plugin_agentshield_agentshield"],
  protected_paths: [],
  extra_ask_commands: [],
  pii: ["card", "aadhaar", "pan", "email"],
  ai_judge: "on",
  guardrails_off: [],
  custom_rules: [],
  locked: ["rule_of_two"],
  profiles: {
    developer: { rank: 1, description: "Balanced default: WARNING asks, MILD notes" },
    tester: { rank: 1, description: "Balanced, plus known test data (test card numbers) is not flagged", allow_test_data: true },
    intern: {
      rank: 2,
      description: "Strictest day to day: WARNING blocks, coach messages always on, no personal host additions",
      warning_action: "block",
      coach_messages: "always",
      locked: ["warning_action", "allowed_hosts", "allowed_remotes", "coach_messages"],
    },
    contractor: {
      rank: 3,
      description: "Strict and locked: WARNING blocks, reads outside the project ask, nothing personal can change",
      warning_action: "block",
      coach_messages: "always",
      outside_reads: "ask",
      approvals: "off",
      circuit_breaker: 2,
      locked: ["warning_action", "allowed_hosts", "allowed_remotes", "trusted_mcp_servers", "coach_messages", "mild_notes", "outside_reads", "approvals", "circuit_breaker"],
    },
  },
};

export interface EffectivePolicy {
  name: string;
  mode: "enforce" | "monitor";
  profile: string;
  assignedProfile: string;
  settings: Settings;
  /** Which layer decided each setting. */
  sources: Record<SettingKey, string>;
  /** For list settings: which layer added each entry. */
  entrySources: Partial<Record<SettingKey, Record<string, string>>>;
  /** Which layer locked each setting. */
  locked: Partial<Record<SettingKey, string>>;
  /** Loosening attempts that were ignored, and other notes. */
  warnings: string[];
  layers: { label: string; path?: string }[];
  profiles: Record<string, { rank: number; description?: string }>;
  consoleUrl?: string;
  /** Custom rules from every layer, each with the layer that added it. No layer can remove a higher layer's rule. */
  customRules: (CustomRule & { source: string; pack?: string })[];
  /** Where AI requests go when there is no GEMINI_API_KEY. Set by the company or the developer, never by a repository. */
  aiEndpoint?: string;
}

export class PolicyError extends Error {}

export interface PolicyPaths {
  company?: string;
  project?: string;
  user: string;
}

export interface LoadOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function userDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.AGENTSHIELD_HOME || join(home, ".agentshield");
}

/** The admin-owned path wins. The environment variable is for demos and tests on unmanaged machines. */
export function companyPolicyPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const admin =
    process.platform === "win32"
      ? join(env.ProgramData ?? "C:\\ProgramData", "AgentShield", "policy.yaml")
      : process.platform === "darwin"
        ? "/Library/Application Support/AgentShield/policy.yaml"
        : "/etc/agentshield/policy.yaml";
  if (existsSync(admin)) return admin;
  return env.AGENTSHIELD_COMPANY_POLICY ? resolve(env.AGENTSHIELD_COMPANY_POLICY) : undefined;
}

/** Walk up from the working folder to the repository root looking for `.agentshield/policy.yaml`. */
export function projectPolicyPath(cwd: string, home = homedir()): string | undefined {
  let dir = resolve(cwd);
  const stop = resolve(home);
  for (let i = 0; i < 25; i++) {
    if (dir === stop) return undefined;
    const candidate = join(dir, ".agentshield", "policy.yaml");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function policyPaths(opts: LoadOptions): PolicyPaths {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  return { company: companyPolicyPath(env), project: projectPolicyPath(opts.cwd, home), user: join(userDir(env, home), "config.yaml") };
}

// The YAML parser is loaded only when a policy file exists: the hook starts on every agent action.
let yamlParse: ((text: string) => unknown) | undefined;
export async function ensureYaml(): Promise<void> {
  yamlParse ??= (await import("yaml")).parse;
}

/** Load the policy, reading the YAML parser first if any layer has a file. Throws PolicyError like loadPolicy. */
export async function loadPolicyAsync(opts: LoadOptions): Promise<EffectivePolicy> {
  const paths = policyPaths(opts);
  if (paths.company || paths.project || existsSync(paths.user)) await ensureYaml();
  return loadPolicy(opts);
}

export function readPolicyFile(path: string, label: string): PolicyFile {
  if (!yamlParse) throw new PolicyError("internal: YAML parser not loaded (call ensureYaml first)");
  let raw: unknown;
  try {
    raw = yamlParse(readFileSync(path, "utf8")) ?? {};
  } catch (err) {
    throw new PolicyError(`${label} policy ${path} is not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  try {
    return parsePolicyFile(raw);
  } catch (err) {
    if (err instanceof SchemaError) throw new PolicyError(`${label} policy ${path}: ${err.message}`);
    throw err;
  }
}

// ---------- Merge ----------

interface MergeState {
  settings: Settings;
  sources: Record<SettingKey, string>;
  entrySources: Partial<Record<SettingKey, Record<string, string>>>;
  locked: Partial<Record<SettingKey, string>>;
  warnings: string[];
}

/** Higher is stricter. -1 for a value outside the allowed set (always a loosening). */
export function strictness(key: SettingKey, value: unknown): number {
  const spec = SPEC[key];
  if (spec.type === "enum") return spec.order.indexOf(String(value));
  if (spec.type === "bool") return value === spec.strict ? 1 : value === !spec.strict ? 0 : -1;
  if (spec.type === "number") return typeof value === "number" ? -value : -Infinity;
  return 0;
}

const normEntry = (key: SettingKey, e: string) => (key === "allowed_hosts" || key === "allowed_remotes" ? e.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : e.trim());

function applyLayer(state: MergeState, label: string, data: PolicyFile, top: boolean): void {
  for (const key of SETTING_KEYS) {
    const value = data[key];
    if (value === undefined) continue;
    const spec = SPEC[key];

    if (spec.type === "list") {
      const current = state.settings[key] as string[];
      const sources = (state.entrySources[key] ??= {});
      for (const rawEntry of value as string[]) {
        const removal = rawEntry.startsWith("!");
        const entry = normEntry(key, removal ? rawEntry.slice(1) : rawEntry);
        const loosens = removal ? spec.add === "tighten" : spec.add === "loosen";
        if (!top && loosens) {
          if (removal) {
            const owner = sources[entry];
            state.warnings.push(
              owner
                ? `${label}: cannot remove "${entry}" from ${key} (set by the ${owner})`
                : `${label}: cannot remove "${entry}" from ${key} (built-in protection)`,
            );
            continue;
          }
          if (state.locked[key]) {
            state.warnings.push(`${label}: cannot add "${entry}" to ${key} (set by the ${state.locked[key]}, locked)`);
            continue;
          }
        }
        if (removal) {
          const i = current.indexOf(entry);
          if (i >= 0) current.splice(i, 1);
          delete sources[entry];
        } else if (!current.includes(entry)) {
          current.push(entry);
          sources[entry] = label;
        }
      }
      state.sources[key] = label;
      continue;
    }

    const loosens = strictness(key, value) < strictness(key, state.settings[key]);
    if (!top && loosens && state.locked[key]) {
      state.warnings.push(`${label}: ignored ${key}=${String(value)} (set by the ${state.locked[key]}, locked)`);
      continue;
    }
    (state.settings as unknown as Record<string, unknown>)[key] = value;
    state.sources[key] = label;
  }
  for (const key of data.locked ?? []) state.locked[key] ??= label;
}

export interface ParsedLayers {
  company?: PolicyFile;
  project?: PolicyFile;
  user?: PolicyFile;
}

/** Merge already-parsed layers. Pure: no files, no environment. */
export function mergePolicy(layers: ParsedLayers, assignedOverride?: string, paths: Partial<PolicyPaths> = {}): EffectivePolicy {
  const base = BUILTIN;
  const state: MergeState = {
    settings: structuredClone(Object.fromEntries(SETTING_KEYS.map((k) => [k, base[k]]))) as unknown as Settings,
    sources: Object.fromEntries(SETTING_KEYS.map((k) => [k, "built-in default"])) as Record<SettingKey, string>,
    entrySources: {},
    locked: {},
    warnings: [],
  };
  for (const key of SETTING_KEYS) {
    const v = base[key];
    if (Array.isArray(v)) state.entrySources[key] = Object.fromEntries(v.map((e) => [e, "built-in default"]));
  }
  for (const key of base.locked ?? []) state.locked[key] = "company";

  const company = layers.company;
  const profiles: Record<string, ProfileDef> = { ...base.profiles, ...company?.profiles };
  const layerList: EffectivePolicy["layers"] = [{ label: "built-in default" }];

  if (company) {
    applyLayer(state, "company", company, true);
    layerList.push({ label: "company", path: paths.company });
  }

  const assigned = assignedOverride || company?.profile || "developer";
  if (!profiles[assigned]) throw new PolicyError(`Unknown profile "${assigned}". Known: ${Object.keys(profiles).join(", ")}`);
  let profile = assigned;
  for (const [label, layer] of [["project", layers.project], ["personal config", layers.user]] as const) {
    const wanted = layer?.profile;
    if (!wanted || wanted === profile) continue;
    if (!profiles[wanted]) throw new PolicyError(`${label}: unknown profile "${wanted}". Known: ${Object.keys(profiles).join(", ")}`);
    if (profiles[wanted]!.rank > profiles[profile]!.rank) profile = wanted;
    else state.warnings.push(`${label}: ignored profile "${wanted}" (not stricter than "${profile}", assigned by the company)`);
  }
  const { rank: _rank, description: _d, ...profileSettings } = profiles[profile]!;
  applyLayer(state, `${profile} profile`, profileSettings as PolicyFile, true);
  layerList.push({ label: `${profile} profile` });

  let mode = company?.mode ?? base.mode ?? "enforce";
  for (const [label, layer, path] of [["project", layers.project, paths.project], ["personal config", layers.user, paths.user]] as const) {
    if (!layer) continue;
    if (layer.mode === "monitor") state.warnings.push(`${label}: ignored mode=monitor (only the company can set monitor mode)`);
    if (layer.profiles) state.warnings.push(`${label}: ignored profiles (only the company defines profiles)`);
    const data = label === "personal config" && layer.locked ? { ...layer, locked: undefined } : layer;
    if (label === "personal config" && layer.locked) state.warnings.push(`${label}: ignored locked (only the company or project can lock settings)`);
    applyLayer(state, label, data, false);
    layerList.push({ label, path });
  }
  if (mode !== "monitor") mode = "enforce";

  const customRules: EffectivePolicy["customRules"] = guardrailRules(state.settings.guardrails_off);
  for (const [label, layer] of [["company", company], ["project", layers.project], ["personal config", layers.user]] as const) {
    for (const r of layer?.custom_rules ?? []) customRules.push({ ...r, source: label });
  }
  // A repository must not be able to send your commands to its own server.
  if (layers.project?.ai_endpoint) state.warnings.push("project: ignored ai_endpoint (only the company or your personal config can set it)");
  if (layers.project?.console_url) state.warnings.push("project: ignored console_url (only your personal config can set it)");

  return {
    name: company?.name ?? base.name ?? "AgentShield",
    mode,
    profile,
    assignedProfile: assigned,
    settings: state.settings,
    sources: state.sources,
    entrySources: state.entrySources,
    locked: state.locked,
    warnings: state.warnings,
    layers: layerList,
    profiles: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, { rank: v.rank, description: v.description }])),
    consoleUrl: layers.user?.console_url,
    customRules,
    aiEndpoint: company?.ai_endpoint ?? layers.user?.ai_endpoint,
  };
}

// ---------- Load with a cache keyed on modification times ----------

const cache = new Map<string, EffectivePolicy>();

const mtime = (p?: string) => {
  if (!p) return "-";
  try {
    return String(statSync(p).mtimeMs);
  } catch {
    return "missing";
  }
};

/** Read every layer that exists. Throws PolicyError when any layer is malformed. */
export function loadLayers(opts: LoadOptions): { layers: ParsedLayers; paths: PolicyPaths } {
  const paths = policyPaths(opts);
  const layers: ParsedLayers = {};
  if (paths.company) {
    if (!existsSync(paths.company)) throw new PolicyError(`company policy ${paths.company} does not exist`);
    layers.company = readPolicyFile(paths.company, "company");
  }
  if (paths.project) layers.project = readPolicyFile(paths.project, "project");
  if (existsSync(paths.user)) layers.user = readPolicyFile(paths.user, "personal");
  return { layers, paths };
}

/** Throws PolicyError when any layer is malformed: callers must fail closed. */
export function loadPolicy(opts: LoadOptions): EffectivePolicy {
  const env = opts.env ?? process.env;
  const paths = policyPaths(opts);
  const key = JSON.stringify([paths, mtime(paths.company), mtime(paths.project), mtime(paths.user), env.AGENTSHIELD_PROFILE ?? "", env.AGENTSHIELD_CONSOLE_URL ?? ""]);
  const hit = cache.get(key);
  if (hit) return hit;

  const { layers } = loadLayers(opts);
  const policy = mergePolicy(layers, env.AGENTSHIELD_PROFILE, paths);
  if (env.AGENTSHIELD_CONSOLE_URL) policy.consoleUrl = env.AGENTSHIELD_CONSOLE_URL;
  if (cache.size > 20) cache.clear();
  cache.set(key, policy);
  return policy;
}

/** Engine default when no policy is given (tests, `check` without files). */
export const DEFAULT_POLICY: EffectivePolicy = mergePolicy({});

/**
 * Used when a policy file cannot be loaded. The agent keeps working, but on the strict built-in rules:
 * warnings become blocks and nothing is remembered, so a broken file never loosens anything and never bricks the agent.
 */
export function fallbackPolicy(reason: string): EffectivePolicy {
  const p = structuredClone(DEFAULT_POLICY);
  p.name = "AgentShield built-in rules (a policy file could not be loaded)";
  p.settings.warning_action = "block";
  p.settings.approvals = "off";
  p.warnings = [`A policy file could not be loaded, so the strict built-in rules are in use: ${reason}`];
  return p;
}

export function explain(policy: EffectivePolicy, key: SettingKey): string[] {
  const value = policy.settings[key];
  const lines = [`${key} = ${Array.isArray(value) ? (value.length ? value.join(", ") : "(empty)") : String(value)}`];
  lines.push(`  decided by: ${policy.sources[key]}`);
  if (policy.locked[key]) lines.push(`  locked by: ${policy.locked[key]} (lower layers can only make it stricter)`);
  const entries = policy.entrySources[key];
  if (entries && Object.keys(entries).length) {
    for (const [entry, from] of Object.entries(entries)) lines.push(`    ${entry}  (${from})`);
  }
  for (const w of policy.warnings.filter((w) => w.includes(` ${key}`) || w.includes(`${key}=`))) lines.push(`  ignored: ${w}`);
  lines.push(`  profile: ${policy.profile}${policy.profile !== policy.assignedProfile ? ` (assigned ${policy.assignedProfile}, stricter chosen)` : ""}`);
  return lines;
}
