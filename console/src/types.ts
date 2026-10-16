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
