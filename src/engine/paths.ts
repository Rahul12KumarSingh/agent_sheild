import path from "node:path";

// Path handling that works the same for macOS, Linux and Windows paths, whatever the host OS.
// Windows-style paths are compared lowercased with forward slashes.

export interface PathContext {
  cwd: string;
  home: string;
  tmpDirs: string[];
  /** Extra secret paths from the policy, compiled from globs. */
  protectedPaths?: RegExp[];
}

const WIN_ABS = /^[a-zA-Z]:([\\/]|$)/;
const looksWindows = (p: string) => WIN_ABS.test(p) || p.startsWith("\\\\");

export function expandHome(raw: string, home: string): string {
  return raw
    .replace(/^~(?=$|[\\/])/, () => home)
    .replace(/\$\{HOME\}|\$HOME\b/g, () => home)
    .replace(/\$env:(?:USERPROFILE|HOME)\b/gi, () => home)
    .replace(/%(?:USERPROFILE|HOMEPATH)%/gi, () => home);
}

export function resolvePath(raw: string, ctx: Pick<PathContext, "cwd" | "home">): string {
  let p = expandHome(raw.trim().replace(/^["']+|["']+$/g, ""), ctx.home);
  // "dir/*" means everything in the folder: same blast radius as the folder itself.
  const stripped = p.replace(/[\\/]+\.?\*{1,2}$/, "");
  p = stripped === "" && /^[\\/]/.test(p) ? "/" : stripped || p;
  if (p === "*" || p === ".*") p = ".";
  if (/^[a-zA-Z]:$/.test(p)) p += "\\";

  if (looksWindows(p) || looksWindows(ctx.cwd)) {
    const r = path.win32.resolve(ctx.cwd, p).replace(/\\/g, "/").toLowerCase();
    return r.length > 3 ? r.replace(/\/+$/, "") : r;
  }
  return path.posix.resolve(ctx.cwd, p);
}

export const isInside = (child: string, parent: string) =>
  child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

export type PathClass = "root" | "home" | "system" | "project-root" | "project" | "temp" | "outside";

const SYSTEM_DIRS = new Set([
  "/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/var", "/opt", "/boot", "/dev", "/proc", "/sys",
  "/system", "/library", "/applications", "/users", "/home", "/private", "/root",
  "c:/windows", "c:/program files", "c:/program files (x86)", "c:/programdata", "c:/users",
]);
const TEMP_DIRS = ["/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

export function classifyPath(raw: string, ctx: PathContext): PathClass {
  const p = resolvePath(raw, ctx);
  const lower = p.toLowerCase();
  const home = resolvePath(ctx.home, ctx);
  const cwd = resolvePath(ctx.cwd, ctx);

  if (p === "/" || /^[a-z]:\/?$/i.test(p)) return "root";
  if (p === home) return "home";
  if (isInside(home, p) || SYSTEM_DIRS.has(lower)) return "system";
  if (p === cwd) return "project-root";
  if (isInside(p, cwd)) return "project";
  const temps = [...TEMP_DIRS, ...ctx.tmpDirs.map((t) => resolvePath(t, ctx).toLowerCase())];
  if (temps.some((t) => lower === t || isInside(lower, t))) return "temp";
  return "outside";
}

// Backslashes are folded to slashes so a Windows-style path in a command still matches when the folder is a POSIX one.
const lowerResolved = (raw: string, ctx: PathContext) => resolvePath(raw, ctx).toLowerCase().replace(/\\/g, "/");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The stable name of a path for approvals: resolved, lowercased, forward slashes. */
export const pathTarget = (raw: string, ctx: PathContext) => lowerResolved(raw, ctx);

const SECRET_FILES = new Set([
  ".envrc", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".htpasswd", ".vault-token",
  "credentials.json", "application_default_credentials.json", "secrets.json", "secrets.yaml", "secrets.yml",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "terraform.tfvars", "credentials.tfrc.json",
]);
const SAFE_ENV_SUFFIX = /\.(example|sample|template|tpl|dist|default|defaults|schema)$/;

/** Files whose contents are credentials. `.env.example` and friends are not. */
export function isSecretPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  const base = baseName(p);
  if (ctx.protectedPaths?.some((re) => re.test(p) || re.test(base))) return true;
  if (/^\.env(\.[\w.-]+)?$/.test(base)) return !SAFE_ENV_SUFFIX.test(base);
  if (SECRET_FILES.has(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|tfstate|tfstate\.backup|auto\.tfvars)$/.test(base)) return true;
  if (/\/\.ssh\/id_[\w-]+$/.test(p) && !p.endsWith(".pub")) return true;
  if (/\/\.(ssh|aws|gnupg|kube)$/.test(p)) return true;
  return /\/\.aws\/credentials$|\/\.kube\/config$|\/\.docker\/config\.json$|\/\.config\/gcloud\/|\/\.azure\/|\/\.config\/gh\/hosts\.yml$|\/library\/keychains\//.test(p);
}

/** `{a,b}` spelled out, a few levels deep. */
function braces(s: string, depth = 0): string[] {
  const m = /\{([^{}]*)\}/.exec(s);
  if (!m || depth > 3) return [s];
  return m[1]!.split(",").flatMap((alt) => braces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), depth + 1)).slice(0, 32);
}

/**
 * A search limited to a pattern such as `.env*`, `**\/*.pem` or `~/.aws/*` reads secrets just like opening the file.
 * True when a name the pattern can match is a secret file, or the folder it starts in holds credentials.
 */
export function globReachesSecret(glob: string, ctx: PathContext): boolean {
  const g = glob.replace(/\\/g, "/");
  if (!/[*?{[]/.test(g)) return false;
  const parts = g.split("/");
  const firstWild = parts.findIndex((p) => /[*?{[]/.test(p));
  const fixed = parts.slice(0, firstWild).join("/");
  if (fixed && isSecretPath(fixed, ctx)) return true;
  for (const alt of braces(parts[parts.length - 1]!)) {
    // `.env.example*` can only match example files: do not invent a secret name for it.
    const fills = SAFE_ENV_SUFFIX.test(alt.split(/[*?[]/)[0]!) ? [""] : ["", "x", ".x", "-x"];
    for (const fill of fills) {
      const name = alt.replace(/\*+/g, fill).replace(/\?/g, "x").replace(/\[[^\]]*\]/g, "x");
      if (name && isSecretPath(name, ctx)) return true;
    }
  }
  return false;
}

// Where each agent app keeps its hooks and settings. The agent must never change these: they are its guardrails.
const GUARDRAIL_FILES: RegExp[] = [
  /\/\.claude\/settings(\.local)?\.json$/,
  /\/\.claude\.json$/,
  /\/managed-settings\.json$/,
  /\/\.claude\/plugins\/.*agentshield/,
  /\/plugin\/runtime\/agentshield\.js$/,
  /\/\.agentshield(\/|$)/,
  /\/\.cursor\/hooks\.json$/,
  /\/\.github\/hooks(\/|$)/,
  /\/\.github\/copilot\/settings(\.local)?\.json$/,
  /\/\.copilot\/(hooks(\/|$)|settings\.json$|config\.json$)/,
  /\/\.(windsurf|devin)\/hooks\.json$/,
  /\/\.codeium\/(windsurf\/)?hooks\.json$/,
  /\/\.gemini\/settings\.json$/,
  /\/\.agents\/hooks\.json$/,
  /\/\.gemini\/config\/hooks\.json$/,
  /\/\.gemini\/antigravity(-cli|-ide)?\/settings\.json$/,
  /\/\.codex\/(hooks\.json|config\.toml)$/,
  // Company-wide locations (policy, managed settings)
  /\/etc\/(github-copilot\/policy\.d|cursor|devin|windsurf|agentshield|claude-code)(\/|$)/,
  /\/library\/application support\/(cursor|devin|windsurf|agentshield|claudecode|github copilot)(\/|$)/,
  /^[a-z]:\/programdata\/(github\/copilot|cursor|devin|windsurf|agentshield|claudecode)(\/|$)/,
];

/** The folders that hold those files. Deleting or moving one removes the guardrails with it. */
const GUARDRAIL_DIRS = /\/\.(claude|cursor|windsurf|devin|gemini|codex|copilot|agentshield|agents|codeium(?:\/windsurf)?|github(?:\/hooks|\/copilot)?)$/;

/** Hook settings and AgentShield's own policy: the agent must never change these. */
export function isGuardrailPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  return GUARDRAIL_FILES.some((re) => re.test(p));
}

/** A guardrail file, or a folder that holds guardrail files (for delete and move). */
export function isGuardrailOrParent(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  return GUARDRAIL_FILES.some((re) => re.test(p)) || GUARDRAIL_DIRS.test(p);
}

const CI_FILES = /\/\.github\/workflows(\/|$)|\/\.gitlab-ci\.ya?ml$|\/jenkinsfile$|\/azure-pipelines\.ya?ml$|\/\.circleci(\/|$)|\/bitbucket-pipelines\.yml$|\/\.buildkite(\/|$)/;

/** Files nobody should delete without a person noticing: secrets, git history, CI pipelines. */
export function isSensitiveToDelete(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  return isSecretPath(raw, ctx) || /\/\.git(\/|$)/.test(p) || CI_FILES.test(p);
}

/** CI and build automation: a changed line here runs on other people's machines. */
export function isAutomationPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  return CI_FILES.test(p) || /\/(\.husky\/|makefile$|dockerfile$|package\.json$|setup\.py$|noxfile\.py$|justfile$)/.test(p);
}

/** Files the agent reads as instructions or loads as tools: writing them can make an injection persist. */
export function isInstructionPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  const base = baseName(p);
  return (
    ["claude.md", "claude.local.md", "agents.md", "gemini.md", ".cursorrules", ".windsurfrules", ".clinerules", "copilot-instructions.md", ".mcp.json"].includes(base) ||
    /\/\.(cursor\/rules|cursor\/mcp\.json|vscode\/mcp\.json|windsurf\/rules|windsurf\/workflows|claude\/agents|claude\/commands|claude\/skills|github\/instructions|agents\/(mcp_config\.json|skills|rules)|gemini\/config\/mcp_config\.json)(\/|$)/.test(p)
  );
}

export function isPersistencePath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  const base = baseName(p);
  return (
    [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".zshenv", ".profile", ".login", "microsoft.powershell_profile.ps1", "profile.ps1"].includes(base) ||
    /\/library\/(launchagents|launchdaemons)\/|\/\.config\/autostart\/|\/start menu\/programs\/startup\/|^\/etc\/(cron|systemd)|\/\.git\/hooks\/|\/\.git\/config$|\/\.husky\//.test(p)
  );
}

export const isAuthorizedKeys = (raw: string, ctx: PathContext) => /\/\.ssh\/authorized_keys2?$/.test(lowerResolved(raw, ctx));

/** Downloaded or third-party code: its text is a stranger's text. */
export function isThirdPartyPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  return /\/(node_modules|vendor|third_party|third-party|site-packages|bower_components)\/|\/downloads\/|\/\.cargo\/registry\//.test(p);
}

/**
 * Policy globs: `*.tfstate` matches a file name anywhere, `secrets/**` or `~/.config/acme/**` match by path.
 * Compiled against the same lowercased, resolved form that isSecretPath uses.
 */
export function compileProtectedPaths(globs: string[], ctx: Pick<PathContext, "cwd" | "home">): RegExp[] {
  return globs.map((glob) => {
    const hasSlash = /[\\/]/.test(glob.replace(/[\\/]+$/, ""));
    const target = hasSlash ? resolvePath(glob.replace(/\*\*/g, "__DSTAR__").replace(/\*/g, "__STAR__"), ctx) : glob.toLowerCase();
    const body = target
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/__dstar__|\*\*/g, "\u0000")
      .replace(/__star__|\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*")
      .replace(/\/\.\*$/, "(?:/.*)?");
    return new RegExp(`^${body}(?:/.*)?$`, "i");
  });
}
