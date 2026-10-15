import path from "node:path";

// Path handling that works the same for macOS, Linux and Windows paths, whatever the host OS.
// Windows-style paths are compared lowercased with forward slashes.

export interface PathContext {
  cwd: string;
  home: string;
  tmpDirs: string[];
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

const lowerResolved = (raw: string, ctx: PathContext) => resolvePath(raw, ctx).toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

const SECRET_FILES = new Set([
  ".envrc", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".htpasswd",
  "credentials.json", "application_default_credentials.json", "secrets.json", "secrets.yaml", "secrets.yml",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const SAFE_ENV_SUFFIX = /\.(example|sample|template|tpl|dist|default|defaults|schema)$/;

/** Files whose contents are credentials. `.env.example` and friends are not. */
export function isSecretPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  const base = baseName(p);
  if (/^\.env(\.[\w.-]+)?$/.test(base)) return !SAFE_ENV_SUFFIX.test(base);
  if (SECRET_FILES.has(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(base)) return true;
  if (/\/\.ssh\/id_[\w-]+$/.test(p) && !p.endsWith(".pub")) return true;
  if (/\/\.(ssh|aws|gnupg|kube)$/.test(p)) return true;
  return /\/\.aws\/credentials$|\/\.kube\/config$|\/\.docker\/config\.json$|\/\.config\/gcloud\/|\/\.azure\//.test(p);
}

/** Hook settings and AgentShield's own policy: the agent must never change these. */
export function isGuardrailPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  return (
    /\/\.claude\/settings(\.local)?\.json$/.test(p) ||
    /\/managed-settings\.json$/.test(p) ||
    /\/\.agentshield(\/|$)/.test(p) ||
    /\/\.cursor\/hooks\.json$/.test(p) ||
    /\/\.github\/hooks(\/|$)/.test(p) ||
    /\/\.copilot\/hooks(\/|$)/.test(p)
  );
}

/** Files the agent reads as instructions: writing them can make an injection persist. */
export function isInstructionPath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  const base = baseName(p);
  return (
    ["claude.md", "claude.local.md", "agents.md", "gemini.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"].includes(base) ||
    /\/\.(cursor\/rules|claude\/agents|claude\/commands|claude\/skills|github\/instructions)\//.test(p)
  );
}

export function isPersistencePath(raw: string, ctx: PathContext): boolean {
  const p = lowerResolved(raw, ctx);
  const base = baseName(p);
  return (
    [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".zshenv", ".profile", ".login", "microsoft.powershell_profile.ps1", "profile.ps1"].includes(base) ||
    /\/library\/(launchagents|launchdaemons)\/|\/\.config\/autostart\/|\/start menu\/programs\/startup\/|^\/etc\/(cron|systemd)/.test(p)
  );
}

export const isAuthorizedKeys = (raw: string, ctx: PathContext) => /\/\.ssh\/authorized_keys2?$/.test(lowerResolved(raw, ctx));
