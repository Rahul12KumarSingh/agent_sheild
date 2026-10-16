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
  | "SESSION"
  | "GIT";

export type AgentId = "claude" | "copilot" | "cursor" | "windsurf" | "gemini" | "antigravity" | "scripted";

interface EventBase {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  /** True when no human can answer an ask (CI, headless runs): ask becomes deny. */
  headless: boolean;
  /** Which hook of the agent app this came from (for example "beforeShellExecution"). Decides the answer's shape. */
  surface?: string;
}

export interface PromptEvent extends EventBase {
  kind: "prompt";
  text: string;
}

export interface ActionEvent extends EventBase {
  kind: "action";
  /** The canonical tool name, e.g. "Bash", "Write", "WebFetch", "mcp__github__create_issue". */
  tool: string;
  input: Record<string, unknown>;
  /** The agent's own id for this tool call, when it has one. Ties a result back to the action we asked about. */
  toolUseId?: string;
  /** The tool name as the agent app wrote it, when the adapter renamed it. */
  rawTool?: string;
}

export interface ResultEvent extends EventBase {
  kind: "result";
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  toolUseId?: string;
  rawTool?: string;
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
  /** What the finding is about (a resolved path, a host or a command), used to remember an approval. */
  target?: string;
  /** A rule-specific safe alternative (custom rules); otherwise the catalog's. */
  alternative?: string;
}

/** One thing a person is asked to approve. Approving it once can cover the same thing for the rest of the session. */
export interface ApprovalItem {
  ruleId: string;
  target: string;
  /** Short, redacted text for the approvals list. */
  label: string;
  /** False for rules that must be asked every time (a tripped Rule of Two, privilege, persistence). */
  rememberable: boolean;
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
  /** Monitor mode: what enforce mode would have done. The action itself is then "allow". */
  monitored?: Action;
  /** Set when an earlier approval turned this ask into a note. */
  approved?: boolean;
  /** What a person is being asked to approve (action "ask", or a deny because the agent app cannot ask). */
  asks?: ApprovalItem[];
  /** AgentShield's own approval flow (Claude Code): paused for the user, allowed once, or the user's "allow". */
  approval?: { state: "needed" | "granted" | "acknowledged"; summary: string };
  /** The Rule of Two legs after this event (A stranger's text, B sensitive data, C this action reaches outside). */
  session?: { A?: string; B?: string; C?: string; blocks: number; ruleOfTwo: boolean };
}
