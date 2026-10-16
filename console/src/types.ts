// Shapes returned by the AgentShield API. Kept separate from the server code so the console builds on its own.

export type Level = "SEVERE" | "WARNING" | "MILD" | "CLEAN";
export type Action = "block" | "ask" | "note" | "allow";

export interface FindingView {
  ruleId: string;
  category: string;
  level: Exclude<Level, "CLEAN">;
  reason: string;
  excerpt?: string;
}

export interface ShieldRecord {
  id: string;
  ts: string;
  agent: string;
  session: string;
  kind: "prompt" | "action" | "result";
  tool?: string;
  summary: string;
  action: Action;
  level: Level;
  score: number;
  rules: string[];
  findings: FindingView[];
  reason: string;
  safeAlternative?: string;
  monitored?: Action;
  /** An earlier approval turned an ask into a note. */
  approved?: boolean;
  legs: { A?: string; B?: string; C?: string };
  ruleOfTwo: boolean;
  profile?: string;
  delivered?: { exitCode: number; message?: string };
  demo?: boolean;
  runId?: string;
  step?: number;
}

export interface Counters {
  events: number;
  blocked: number;
  asked: number;
  secretsKeptOut: number;
  promptsCoached: number;
  ruleOfTwo: number;
  demoEvents: number;
}

export interface GeminiStatus {
  enabled: boolean;
  provider: string;
  model: string;
}

export interface Info {
  name: string;
  version: string;
  policy: { name: string; mode: string; profile: string };
  gemini: GeminiStatus;
  counters: Counters;
  demo: boolean;
  /** Running on this computer via `agentshield setup`: the settings page can save. */
  local?: boolean;
}

export interface ScenarioSummary {
  id: string;
  slug: string;
  title: string;
  headline: boolean;
  summary: string;
  expected: string;
  steps: number;
}

export interface StepResult {
  index: number;
  actor: "user" | "agent" | "tool" | "human";
  say: string;
  gate?: number;
  expect?: Action;
  delivered?: { exitCode: number; message?: string };
  record?: ShieldRecord;
  ok: boolean;
}

export interface ScenarioRun {
  runId: string;
  scenario: { id: string; slug: string; title: string; summary: string; expected: string; withoutShield: { outcome: string; leak: string } };
  steps: StepResult[];
  passed: boolean;
  label: string;
}

export interface Span {
  start: number;
  end: number;
  label: string;
}

export interface CoachResult {
  as: "prompt" | "command";
  profile: string;
  decision: { action: Action; level: Level; score: number; findings: FindingView[]; reason: string; safeAlternative?: string };
  spans: Span[];
  rewrite: { text: string; source: "gemini" | "template"; note?: string; ms?: number } | null;
  judge: { level: Level; reason: string; categories: string[]; ms: number; model: string } | null;
  gemini: GeminiStatus;
}

export interface PolicyView {
  name: string;
  mode: string;
  profile: string;
  settings: Record<string, unknown>;
  sources: Record<string, string>;
  locked: Record<string, string>;
  profiles: Record<string, { rank: number; description?: string }>;
  rules: { id: string; category: string; level: Exclude<Level, "CLEAN">; title: string; alternative: string }[];
}

// ---------- Settings: custom rules, AI judge, local policy files ----------

export type RuleKind = "command" | "path" | "host" | "text";

export interface CustomRule {
  id: string;
  description: string;
  kind: RuleKind;
  patterns: string[];
  action: "block" | "ask";
  on?: ("read" | "write")[];
  alternative?: string;
  /** Which layer added it (effective rules only). */
  source?: string;
}

export interface DraftResult {
  rules: CustomRule[];
  examples: { stop: string[]; allow: string[] };
  refused?: string;
  rejected: { rule: unknown; problem: string }[];
  check: { examples: { text: string; expect: "stop" | "allow"; got: Action; rules: string[]; ok: boolean }[]; overbroad: { text: string; rules: string[] }[] };
  via: string;
  model?: string;
  ms?: number;
}

export type SettingsLayer = "project" | "user";

export interface Settings {
  warning_action: "ask" | "block";
  rule_of_two: "ask" | "block";
  mild_notes: "on" | "off";
  coach_messages: "always" | "on_block" | "off";
  outside_reads: "allow" | "ask";
  allow_test_data: boolean;
  circuit_breaker: number;
  allowed_hosts: string[];
  allowed_remotes: string[];
  trusted_mcp_servers: string[];
  protected_paths: string[];
  extra_ask_commands: string[];
  pii: string[];
  ai_judge: "off" | "on" | "strict";
  guardrails_off: string[];
}

export type PolicyFileView = Partial<Settings> & { custom_rules?: CustomRule[]; [k: string]: unknown };

export interface LocalState {
  cwd: string;
  projectRoot: string | null;
  paths: { company: string | null; project: string | null; user: string };
  userFileDisplay: string;
  exists: { project: boolean; user: boolean };
  mtimes: { project: number | null; user: number | null };
  files: { project: PolicyFileView | null; user: PolicyFileView | null };
  errors: { company?: string; project?: string; user?: string };
  policy: {
    name: string;
    mode: string;
    profile: string;
    settings: Settings;
    sources: Record<string, string>;
    locked: Record<string, string>;
    warnings: string[];
    customRules: CustomRule[];
  } | null;
  hooks: { project: boolean; user: boolean; copilot: boolean };
  guardrails: { id: string; name: string; summary: string; examples: string[]; on: boolean; lockedBy: string | null }[];
  ai: { localKey: boolean; endpoint: string; via: string };
  stateDir: string;
}

export type TestResult = { as: "prompt" | "command"; decision: CoachResult["decision"] };
