import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { HookOutput } from "../adapters/claude.js";
import {
  DESCRIPTIONS,
  ensureYaml,
  explain,
  loadLayers,
  loadPolicy,
  mergePolicy,
  parseCliValue,
  parsePolicyFile,
  type PolicyFile,
  SETTING_KEYS,
  type SettingKey,
  SPEC,
  strictness,
} from "../policy/index.js";

interface Opts {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const USAGE = `Usage:
  agentshield config show                 Effective settings, who decided each, what is locked
  agentshield config explain <key>        Which layer decided <key>, and why
  agentshield config set <key> <value>    Change a personal setting (lists: comma separated, "!x" removes)
  agentshield config path                 Where each policy layer lives

Keys: ${SETTING_KEYS.join(", ")}, profile, console_url`;

const fail = (msg: string): HookOutput => ({ exitCode: 1, stderr: msg });
const ok = (msg: string): HookOutput => ({ exitCode: 0, stdout: msg });

export async function configCommand(args: string[], opts: Opts): Promise<HookOutput> {
  const [sub, key, ...rest] = args;
  try {
    await ensureYaml();
    switch (sub) {
      case "show":
        return show(opts);
      case "explain":
        if (!key || !isKey(key)) return fail(`Unknown key "${key ?? ""}".\n\n${USAGE}`);
        return ok(explain(loadPolicy(opts), key).join("\n"));
      case "set":
        if (!key || rest.length === 0) return fail(USAGE);
        return await set(key, rest.join(" "), opts);
      case "path": {
        const { paths } = loadLayers(opts);
        return ok([`company:  ${paths.company ?? "(none: built-in default)"}`, `project:  ${paths.project ?? "(none)"}`, `personal: ${paths.user}`].join("\n"));
      }
      default:
        return fail(USAGE);
    }
  } catch (err) {
    return fail(`AgentShield: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const isKey = (k: string): k is SettingKey => (SETTING_KEYS as string[]).includes(k);

function show(opts: Opts): HookOutput {
  const p = loadPolicy(opts);
  const lines = [`Policy: ${p.name}   Mode: ${p.mode.toUpperCase()}   Profile: ${p.profile}`, ""];
  for (const key of SETTING_KEYS) {
    const v = p.settings[key];
    const value = Array.isArray(v) ? (v.length ? v.join(", ") : "(empty)") : String(v);
    lines.push(`${p.locked[key] ? "[locked] " : "         "}${key} = ${value}   (${p.sources[key]})`);
  }
  if (p.warnings.length) lines.push("", "Ignored:", ...p.warnings.map((w) => `  ${w}`));
  return ok(lines.join("\n"));
}

function isLoosening(key: SettingKey, value: unknown, current: unknown): boolean {
  const spec = SPEC[key];
  if (spec.type === "list") {
    const entries = Array.isArray(value) ? (value as string[]) : [];
    return entries.some((e) => (e.startsWith("!") ? spec.add === "tighten" : spec.add === "loosen"));
  }
  return strictness(key, value) < strictness(key, current);
}

async function set(key: string, raw: string, opts: Opts): Promise<HookOutput> {
  const { layers, paths } = loadLayers(opts);
  const before = mergePolicy(layers, opts.env.AGENTSHIELD_PROFILE, paths);
  let value: unknown = raw;

  if (key === "profile") {
    const target = before.profiles[raw];
    if (!target) return fail(`refused: unknown profile "${raw}". Known: ${Object.keys(before.profiles).join(", ")}`);
    const assigned = before.profiles[before.assignedProfile]!;
    if (raw !== before.assignedProfile && target.rank <= assigned.rank) {
      return fail(`refused: profile "${raw}" is not stricter than "${before.assignedProfile}" (set by the company). You may only pick a stricter profile.`);
    }
  } else if (key === "console_url") {
    // validated by the schema below
  } else if (isKey(key)) {
    value = parseCliValue(key, raw);
    if (before.locked[key] && isLoosening(key, value, before.settings[key])) {
      return fail(`refused: ${key} is set by the ${before.locked[key]} (locked). You can only make it stricter.\n${DESCRIPTIONS[key]}.`);
    }
  } else {
    return fail(`Unknown key "${key}".\n\n${USAGE}`);
  }

  let parsed: PolicyFile;
  try {
    parsed = parsePolicyFile({ [key]: value });
  } catch (err) {
    return fail(`refused: invalid value for ${err instanceof Error ? err.message : String(err)}`);
  }
  const newValue = (parsed as Record<string, unknown>)[key];

  const after = mergePolicy({ ...layers, user: { ...layers.user, [key]: newValue } }, opts.env.AGENTSHIELD_PROFILE, paths);
  const blocked = after.warnings.find((w) => w.startsWith("personal config") && !before.warnings.includes(w));
  if (blocked) return fail(`refused: ${blocked.replace(/^personal config: /, "")}`);

  const { parseDocument } = await import("yaml");
  const doc = existsSync(paths.user) ? parseDocument(readFileSync(paths.user, "utf8")) : parseDocument("# AgentShield personal settings. Edit with `agentshield config set`.\n{}\n");
  doc.set(key, newValue);
  mkdirSync(dirname(paths.user), { recursive: true });
  writeFileSync(paths.user, String(doc));

  if (key === "profile") return ok(`accepted: profile = ${raw} (stricter than ${before.assignedProfile})`);
  if (key === "console_url") return ok(`accepted: console_url = ${raw}. Events are sent there (redacted, best effort).`);
  const k = key as SettingKey;
  const shown = Array.isArray(after.settings[k]) ? (after.settings[k] as string[]).join(", ") : String(after.settings[k]);
  const kind = isLoosening(k, value, before.settings[k]) ? "a personal choice" : "stricter or equal";
  return ok(`accepted: ${k} = ${shown} (${kind}, saved to ${paths.user})`);
}
