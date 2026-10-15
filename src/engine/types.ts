// Shared types: the engine only knows prompts, actions and results.
// Adapters translate each agent app's own format into these.

export type Level = "SEVERE" | "WARNING" | "MILD" | "CLEAN";

/** AgentShield never approves. Silence (allow) leaves the agent's own permission rules in charge. */
export type Action = "block" | "ask" | "note" | "allow";

export type Category =
  | "SECRET"
  | "PII"
  | "INJECT"
  | "EXFIL"
  | "DESTROY"
  | "EXEC"
  | "PRIV"
  | "SUPPLY"
  | "TAMPER"
  | "SESSION";

export type AgentId = "claude" | "copilot" | "cursor" | "scripted";

interface EventBase {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  /** True when no human can answer an ask (CI, headless runs): ask becomes deny. */
  headless: boolean;
}

export interface PromptEvent extends EventBase {
  kind: "prompt";
  text: string;
}

export interface ActionEvent extends EventBase {
  kind: "action";
  /** The agent's own tool name, e.g. "Bash", "Write", "WebFetch", "mcp__github__create_issue". */
  tool: string;
  input: Record<string, unknown>;
}

export interface ResultEvent extends EventBase {
  kind: "result";
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
}

export type ShieldEvent = PromptEvent | ActionEvent | ResultEvent;

export interface Finding {
  ruleId: string;
  category: Category;
  level: Exclude<Level, "CLEAN">;
  /** 0 to 1. */
  confidence: number;
  reason: string;
  /** Redacted snippet of what matched, safe to log. */
  excerpt?: string;
}

export interface Decision {
  action: Action;
  level: Level;
  /** 0 to 100. */
  score: number;
  findings: Finding[];
  /** One-line explanation shown to the user and the agent. */
  reason: string;
  /** Required whenever action is "block". */
  safeAlternative?: string;
}
