import { clip, dedupe, hit } from "./catalog.js";
import { redactSecrets } from "./detectors.js";
import { normalizeCommand } from "./normalize.js";
import {
  classifyPath,
  isAuthorizedKeys,
  isGuardrailOrParent,
  isGuardrailPath,
  isInstructionPath,
  isPersistencePath,
  isSecretPath,
  isSensitiveToDelete,
  type PathContext,
  pathTarget,
} from "./paths.js";
import type { Finding } from "./types.js";

// Shell command analysis for Bash, zsh, PowerShell and cmd.exe. Not a full parser: it splits
// statements, strips wrappers like sudo, and reads the command word, arguments and redirects.

export interface Segment {
  cmd: string;
  /** The command word as written, e.g. "./scripts/sync.sh". */
  word: string;
  args: string[];
  positional: string[];
  redirectsOut: string[];
  redirectsIn: string[];
  wrappers: string[];
  text: string;
}

// Statement separators, subshells and PowerShell script blocks. `${HOME}` is not a script block.
const SPLIT = /\|\||&&|[;|\n()`}]|\$\(|(?<!\$)\{/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "powershell", "pwsh", "cmd"]);
const WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "command", "exec", "builtin", "nice", "xargs", "env", "&", ".", "call", "start", "timeout", "watch"]);

export function commandName(token: string): string {
  const t = token.replace(/^["']+|["']+$/g, "");
  const base = t.split(/[\\/]/).pop() || t;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

function tokenize(part: string): string[] {
  const out: string[] = [];
  for (const t of part.trim().split(/\s+/).filter(Boolean)) {
    const m = /^\d?>>?$/.test(t) ? null : /^(\d?>>?|<)(.+)$/.exec(t);
    if (m && !/^&\d$/.test(m[2]!)) out.push(m[1]!, m[2]!);
    else out.push(t);
  }
  return out;
}

export function parseSegments(text: string, depth = 0): Segment[] {
  const result: Segment[] = [];
  for (const part of text.split(SPLIT)) {
    let tokens = tokenize(part);
    const wrappers: string[] = [];
    while (tokens.length > 1) {
      const first = tokens[0]!;
      if (/^[A-Za-z_]\w*=/.test(first)) {
        tokens = tokens.slice(1);
        continue;
      }
      const base = commandName(first);
      if (!WRAPPERS.has(base)) break;
      wrappers.push(base);
      tokens = tokens.slice(1);
      while (tokens.length > 1 && (tokens[0]!.startsWith("-") || /^\d+[smh]?$/.test(tokens[0]!))) {
        const flag = tokens.shift()!;
        if (base === "sudo" && /^-[ugCDhpRrTt]$/.test(flag)) tokens.shift();
      }
    }
    // Redirects first: a segment can start with one (e.g. the tail of `echo {} > file`).
    const words: string[] = [];
    const redirectsOut: string[] = [];
    const redirectsIn: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const a = tokens[i]!;
      if (/^\d?>>?$/.test(a)) {
        const target = tokens[i + 1];
        if (target && !target.startsWith("&")) redirectsOut.push(target);
        i++;
      } else if (a === "<") {
        const source = tokens[i + 1];
        if (source) redirectsIn.push(source);
        i++;
      } else if (!/^\d?>&\d$/.test(a)) {
        words.push(a);
      }
    }
    if (words.length === 0 && redirectsOut.length === 0 && redirectsIn.length === 0) continue;

    const cmd = words[0] ? commandName(words[0]) : "";
    const args = words.slice(1);

    // bash -c "...", powershell -Command ..., cmd /c ...: analyse the inner command.
    if (SHELLS.has(cmd) && depth < 3) {
      const i = args.findIndex((a) => /^(-c|-command|\/c|\/k)$/i.test(a));
      if (i >= 0) {
        for (const s of parseSegments(args.slice(i + 1).join(" "), depth + 1)) {
          result.push({ ...s, wrappers: [...wrappers, ...s.wrappers] });
        }
        // A redirect written after the quoted command belongs to the wrapper: keep it.
        if (redirectsOut.length || redirectsIn.length) {
          result.push({ cmd: "", word: "", args: [], positional: [], redirectsOut, redirectsIn, wrappers, text: part.trim() });
        }
        continue;
      }
    }

    const positional = args.filter((a) => !a.startsWith("-"));
    result.push({ cmd, word: words[0] ?? "", args, positional, redirectsOut, redirectsIn, wrappers, text: part.trim() });
  }
  return result;
}

// ---------- Hosts ----------

const DUMP_HOSTS = [
  "webhook.site", "requestbin.net", "requestbin.com", "pipedream.net", "hookbin.com", "beeceptor.com",
  "requestcatcher.com", "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "pastebin.com",
  "paste.ee", "hastebin.com", "transfer.sh", "file.io", "0x0.st", "temp.sh", "termbin.com", "ix.io",
  "oast.fun", "oast.pro", "oast.live", "oast.site", "oast.online", "oast.me", "interact.sh",
  "burpcollaborator.net", "oastify.com", "canarytokens.com", "dnslog.cn", "serveo.net", "localtunnel.me", "loca.lt",
];
const DUMP_URLS = [/discord(?:app)?\.com\/api\/webhooks/i, /api\.telegram\.org\/bot/i];

export const isDumpHost = (host: string) => DUMP_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));

export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0" ||
    host === "::1" || host === "[::1]" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "host.docker.internal"
  );
}

export function urlHosts(text: string): string[] {
  return [...text.matchAll(/\bhttps?:\/\/(?:[^@\s/'"]+@)?([^/\s'"`)?#:]+)/gi)].map((m) => m[1]!.toLowerCase());
}

const NET_CMDS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "scp", "sftp", "ftp", "rsync",
  "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "http", "https", "xh", "gh",
]);
const HOSTLIKE = /^(?:[\w-]+@)?((?:[\w-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/:]|$)/i;

export function segmentHosts(s: Segment): string[] {
  const hosts = urlHosts(s.text);
  for (const a of s.positional) {
    if (/^https?:/i.test(a)) continue;
    const m = HOSTLIKE.exec(a);
    if (m && (s.cmd !== "gh" || /^https?:/.test(a))) hosts.push(m[1]!.toLowerCase());
  }
  if (["nc", "ncat", "netcat", "telnet"].includes(s.cmd) && s.positional[0]) hosts.push(s.positional[0].toLowerCase());
  if (s.cmd === "gh") hosts.push("github.com");
  return [...new Set(hosts)];
}

const isNet = (s: Segment) => NET_CMDS.has(s.cmd) || /net\.webclient|\.upload(file|string|data)\s*\(/i.test(s.text);
const outsideHosts = (s: Segment) => segmentHosts(s).filter((h) => !isLocalHost(h));

export const hostAllowed = (host: string, allowed: string[]) => allowed.some((a) => host === a || host.endsWith(`.${a}`));

/** Files a network command sends. "-" means stdin. */
function uploads(s: Segment): string[] {
  const files: string[] = [];
  const a = s.args;
  const fileOf = (v: string | undefined) => {
    if (!v) return;
    const at = v.indexOf("@");
    if (v.startsWith("<")) files.push(v.slice(1));
    else if (at >= 0 && !/^[\w.-]+@[\w-]+\.[\w.]+$/.test(v)) files.push(v.slice(at + 1));
  };
  switch (s.cmd) {
    case "curl":
      for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const attached = /^(-d|-F)(.+)$/.exec(x);
        if (attached) fileOf(attached[2]);
        else if (/^(-d|--data|--data-binary|--data-raw|--data-ascii|--data-urlencode|--json|-F|--form)$/.test(x)) fileOf(a[++i]);
        else if (x === "-T" || x === "--upload-file") files.push(a[++i] ?? "");
      }
      break;
    case "wget":
      for (let i = 0; i < a.length; i++) {
        const m = /^--(post|body)-file(?:=(.+))?$/.exec(a[i]!);
        if (m) files.push(m[2] ?? a[++i] ?? "");
      }
      break;
    case "invoke-webrequest":
    case "iwr":
    case "invoke-restmethod":
    case "irm":
      for (let i = 0; i < a.length; i++) if (/^-infile$/i.test(a[i]!)) files.push(a[++i] ?? "");
      break;
    case "scp":
    case "sftp":
    case "rsync": {
      const dest = s.positional.at(-1);
      if (dest && dest.includes(":")) files.push(...s.positional.slice(0, -1).filter((p) => !p.includes(":")));
      break;
    }
    case "gh":
      if (s.positional[0] === "gist" && s.positional[1] === "create") files.push(...s.positional.slice(2));
      break;
    case "http":
    case "https":
    case "xh":
      for (const x of a) if (x.includes("@")) fileOf(x);
      break;
    case "nc":
    case "ncat":
    case "netcat":
    case "socat":
    case "telnet":
      files.push(...s.redirectsIn);
      break;
  }
  return files.filter(Boolean);
}

// ---------- Reading secrets ----------

const READ_VERBS = new Set([
  "cat", "less", "more", "head", "tail", "type", "get-content", "gc", "bat", "strings", "xxd", "od", "hexdump",
  "base64", "nl", "tac", "sed", "awk", "grep", "rg", "zip", "tar", "7z", "openssl", "jq", "yq", "vim", "vi", "nano",
  "select-string", "sls",
]);

/** Commands whose first argument is a pattern, filter or script, not a file: `rg "\.env|x" src`, `jq .a package.json`. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "select-string", "sls", "findstr", "sed", "awk", "gawk", "jq", "yq"]);
const PATTERN_FLAGS = /^(-e|-f|--regexp|--file|--expression)$/;

export function readsSecrets(s: Segment, ctx: PathContext): string[] {
  let files = READ_VERBS.has(s.cmd) ? [...s.positional] : [];
  // The first non-flag argument of these is the thing to look for, not a file (unless -e/-f gave the pattern).
  if (PATTERN_FIRST.has(s.cmd) && files.length > 0 && !s.args.some((a) => PATTERN_FLAGS.test(a))) files = files.slice(1);
  return [...files, ...s.redirectsIn].filter((p) => isSecretPath(p, ctx));
}

export const readsSecret = (s: Segment, ctx: PathContext): string | undefined => readsSecrets(s, ctx)[0];

/** Commands that narrow an environment dump to a few variables: `env | grep PATH` is not a secrets dump. */
const NARROWERS = new Set(["grep", "egrep", "fgrep", "rg", "findstr", "select-string", "sls"]);
const SECRETISH = /key|secret|token|pass|pwd|cred|auth|private|cert|aws|azure|gcp|google|api|ssh|login|session|cookie|bearer|\.\*|^\s*$/i;

function envDumpNarrowed(text: string): boolean {
  const pieces = text.split(/(?<!\|)\|(?!\|)/);
  for (let i = 0; i < pieces.length - 1; i++) {
    if (!parseSegments(pieces[i]!).some(isEnvDump)) continue;
    const next = parseSegments(pieces[i + 1]!)[0];
    if (!next) return false;
    if (next.cmd === "wc") return true;
    if (NARROWERS.has(next.cmd)) {
      const pattern = next.positional[0] ?? "";
      return pattern !== "" && !SECRETISH.test(pattern);
    }
  }
  return false;
}

export function isEnvDump(s: Segment): boolean {
  if ((s.cmd === "env" || s.cmd === "printenv") && s.positional.length === 0) return true;
  if (s.cmd === "set" && s.args.length === 0) return true;
  if (s.cmd === "export" && s.args.join(" ") === "-p") return true;
  if (["get-childitem", "gci", "dir", "ls", "get-item", "gi"].includes(s.cmd) && s.args.some((a) => /^env:[\\/]?\*?$/i.test(a))) return true;
  return s.args.some((a) => /\/proc\/(self|\d+)\/environ/.test(a));
}

// ---------- Deleting ----------

const RM_CMDS = new Set(["rm", "remove-item", "ri", "rd", "rmdir", "del", "erase"]);
const CMD_STYLE = new Set(["rd", "rmdir", "del", "erase"]);

function isRecursiveFlag(cmd: string, a: string): boolean {
  if (/^-[a-zA-Z]{1,3}$/.test(a) && /r/i.test(a)) return true; // -rf, -fr, -r, -R
  if (/^--?rec(u(r(s(e|ive)?)?)?)?$/i.test(a)) return true; // -Recurse, --recursive
  return CMD_STYLE.has(cmd) && /^\/s$/i.test(a);
}

function deleteTargets(s: Segment, ctx: PathContext): string[] | undefined {
  if (RM_CMDS.has(s.cmd)) {
    if (!s.args.some((a) => isRecursiveFlag(s.cmd, a))) return undefined;
    return s.positional.filter((p) => !(CMD_STYLE.has(s.cmd) && /^\/[a-z]$/i.test(p)));
  }
  if (s.cmd === "find" && (s.args.includes("-delete") || /-exec\s+rm\b/.test(s.text))) {
    const root = s.positional.slice(0, 1);
    // `find . -name "*.pyc" -delete` removes what matches, not the project: only the folder it starts in can make it dangerous.
    const filtered = s.args.some((a) => /^-(i?name|i?path|i?regex|mtime|mmin|newer|size|empty|user)$/.test(a)) || s.args.some((a, i) => a === "-type" && s.args[i + 1] === "f");
    return filtered && root.every((r) => !["root", "home", "system"].includes(classifyPath(r, ctx))) ? [] : root;
  }
  return undefined;
}

// ---------- Writing ----------

const MUTATE_VERBS = new Set([
  "rm", "mv", "cp", "tee", "touch", "truncate", "ln", "chmod", "chown", "install", "move", "copy", "unlink", "rmdir", "shred", "rename", "sponge", "patch",
  "set-content", "sc", "add-content", "ac", "out-file", "remove-item", "ri", "del", "erase", "move-item", "mi", "copy-item", "cpi", "new-item", "ni", "rd", "rename-item", "rni", "clear-content", "clc",
]);

/** Verbs that make a file or folder disappear (or leave its place). */
const REMOVE_VERBS = new Set(["rm", "mv", "unlink", "rmdir", "shred", "move", "remove-item", "ri", "del", "erase", "move-item", "mi", "rd", "rename", "rename-item", "rni"]);

/** Files git changes behind your back: `git rm`, `git checkout -- f`, `git restore f`, `git clean`. */
function gitTouchedPaths(s: Segment): { removed: string[]; written: string[] } {
  const sub = s.positional[0];
  const rest = s.positional.slice(1);
  const dashes = s.args.indexOf("--");
  const afterDashes = dashes >= 0 ? s.args.slice(dashes + 1).filter((a) => !a.startsWith("-")) : [];
  switch (sub) {
    case "rm":
    case "mv":
    case "clean":
      return { removed: rest, written: [] };
    case "restore":
    case "checkout":
    case "reset":
      return { removed: [], written: dashes >= 0 ? afterDashes : rest };
    case "stash":
    case "switch":
      return { removed: [], written: afterDashes };
    default:
      return { removed: [], written: [] };
  }
}

function downloadTargets(s: Segment): string[] {
  const a = s.args;
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (s.cmd === "curl") {
      if (x === "-o" || x === "--output" || x === "--output-dir") out.push(a[++i] ?? "");
      else if (/^-o./.test(x)) out.push(x.slice(2));
      else if (/^--output=/.test(x)) out.push(x.slice(9));
    } else if (s.cmd === "wget") {
      if (x === "-O" || x === "--output-document" || x === "-P" || x === "--directory-prefix") out.push(a[++i] ?? "");
      else if (/^-O./.test(x)) out.push(x.slice(2));
      else if (/^--output-document=/.test(x)) out.push(x.slice(18));
    } else if (["invoke-webrequest", "iwr", "invoke-restmethod", "irm"].includes(s.cmd)) {
      if (/^-outfile$/i.test(x)) out.push(a[++i] ?? "");
    } else if (s.cmd === "dd" && /^of=/.test(x)) out.push(x.slice(3));
  }
  return out.filter(Boolean);
}

/** Everything a segment deletes or moves away. */
function removalTargets(s: Segment, ctx: PathContext): string[] {
  const targets: string[] = [];
  if (REMOVE_VERBS.has(s.cmd)) {
    let p = s.positional.filter((x) => !(CMD_STYLE.has(s.cmd) && /^\/[a-z]$/i.test(x)));
    // `mv a b` moves a away and writes b: only the sources count as removed.
    if (MOVE_VERBS.has(s.cmd) && p.length > 1) p = p.slice(0, -1);
    targets.push(...p);
  }
  if (s.cmd === "git") targets.push(...gitTouchedPaths(s).removed);
  if (s.cmd === "find" && (s.args.includes("-delete") || /-exec\s+rm\b/.test(s.text))) {
    targets.push(...s.positional.slice(0, 1));
    // `find . -name ".env*" -delete`: the name filter says what is being deleted.
    for (let i = 0; i < s.args.length - 1; i++) {
      if (!/^-(i?name|i?path)$/.test(s.args[i]!)) continue;
      const v = s.args[i + 1]!.replace(/^["']|["']$/g, "");
      const secret = [v.replace(/\*+/g, ""), v.replace(/\*+/g, "x"), v.replace(/\*+$/, ".local").replace(/\*/g, "x")].find((c) => isSecretPath(c, ctx));
      if (secret) targets.push(secret);
    }
  }
  return targets;
}

const MOVE_VERBS = new Set(["mv", "move", "move-item", "mi", "rename", "rename-item", "rni"]);

/** Git settings that make git run a program: setting one in a repository an agent works in is a way to run code later. */
const GIT_EXEC_CONFIG = /^(core\.(fsmonitor|sshcommand|hookspath|editor|pager|gitproxy)|credential\..*helper|alias\..+|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|url\..+\.insteadof|http\.proxy|include\.path|includeif\..+\.path)$/i;

/** Commands that only look: naming a guardrail file in one of these is not an edit. */
const READERS = new Set([
  "cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ls", "dir", "stat", "file", "wc", "diff", "cmp", "bat", "type",
  "get-content", "gc", "select-string", "sls", "jq", "yq", "find", "tree", "echo", "printf", "test", "realpath", "readlink", "basename",
  "dirname", "sha256sum", "shasum", "md5sum", "du", "git", "gh", "code", "cd", "pwd", "which", "where", "command", "get-childitem", "gci",
  "get-item", "gi", "get-filehash", "test-path", "resolve-path", "write-output", "write-host", "agentshield",
]);

const GUARDRAIL_MENTION =
  /\.claude[\\/](?:settings(?:\.local)?\.json|plugins)|\.claude\.json|managed-settings\.json|\.cursor[\\/]hooks\.json|\.github[\\/](?:hooks|copilot[\\/]settings)|\.copilot[\\/](?:hooks|settings\.json|config\.json)|\.(?:windsurf|devin)[\\/]hooks\.json|\.codeium[\\/](?:windsurf[\\/])?hooks\.json|\.gemini[\\/]settings\.json|\.agents[\\/]hooks\.json|\.gemini[\\/](?:config[\\/]hooks\.json|antigravity(?:-cli|-ide)?[\\/]settings\.json)|\.codex[\\/](?:hooks\.json|config\.toml)|\.agentshield\b/i;

function writeTargets(s: Segment): string[] {
  const targets = [...s.redirectsOut];
  if (MUTATE_VERBS.has(s.cmd)) targets.push(...s.positional);
  if ((s.cmd === "sed" || s.cmd === "perl") && s.args.some((a) => /^-i/.test(a))) targets.push(...s.positional.slice(1));
  targets.push(...downloadTargets(s));
  if (s.cmd === "git") targets.push(...gitTouchedPaths(s).written);
  return targets;
}

// ---------- The analysis ----------

const REMOTE_TO_SHELL: RegExp[] = [
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|python3?|node|perl|ruby|iex|invoke-expression|pwsh|powershell)\b/i,
  /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i,
  /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i,
  /\b(?:iex|invoke-expression)\b[\s(]*(?:\(\s*)?(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+(?:system\.)?net\.webclient)/i,
  /\bdownloadstring\s*\([^)]*\)\s*\|\s*(?:iex|invoke-expression)\b/i,
];

const EXECUTES_DECODED =
  /\|\s*(?:sudo\s+)?(?:(?:ba|z|da)?sh|python3?|node|perl|ruby|iex|invoke-expression)\b|\beval\b|\biex\b|invoke-expression|\b(?:powershell|pwsh)(?:\.exe)?\b[^|]*\s-e(?:nc\w*|c)?\b/i;

const SHIELD_CLI = /^(agentshield|agentshield-hooks|agent-shield)(@[\w.^~-]+)?$/i;

/** The arguments given to AgentShield's own CLI in this segment (npx, pnpm dlx, a global install or node <path>), if any. */
function shieldCliArgs(s: Segment): string | undefined {
  const rest = (args: string[]) => args.join(" ");
  if (SHIELD_CLI.test(s.cmd)) return rest(s.args);
  if (s.cmd === "node" && /agentshield|cli\.js/i.test(s.positional[0] ?? "")) return rest(s.args.slice(s.args.indexOf(s.positional[0]!) + 1));
  if (["npx", "pnpx", "bunx", "pnpm", "yarn", "bun"].includes(s.cmd)) {
    const i = s.args.findIndex((a) => SHIELD_CLI.test(a) || /^--package=(agentshield|agentshield-hooks|agent-shield)/i.test(a));
    if (i >= 0) return rest(s.args.slice(i + 1).filter((a) => !SHIELD_CLI.test(a)));
  }
  return undefined;
}

function analyzeVariant(text: string, ctx: PathContext, excerpt: string, allowedHosts: string[]): Finding[] {
  const out: Finding[] = [];
  const segs = parseSegments(text);

  for (const s of segs) {
    // The agent loosening its own settings through our CLI is tampering, like editing the files directly.
    const shield = shieldCliArgs(s);
    if (shield !== undefined && /\bconfig\s+set\b|\binit\b|\ballow\b|\bapprovals?\s+(?:revoke|clear|remove)\b|\buninstall\b|^\s*(?:setup|settings|ui|serve)\b/i.test(shield)) {
      out.push(hit("TAM-001", `agentshield ${shield.split(" ").slice(0, 2).join(" ")}`, excerpt));
    }

    // Deleting
    const targets = deleteTargets(s, ctx);
    for (const t of targets ?? []) {
      const where = classifyPath(t, ctx);
      if (where === "root" || where === "home" || where === "system") out.push(hit("DES-001", t, excerpt));
      else if (where === "outside" || where === "project-root") out.push(hit("DES-002", t, excerpt, undefined, pathTarget(t, ctx)));
      else if (where === "project") out.push(hit("DES-003", t, excerpt));
    }
    if (/^mkfs/.test(s.cmd) || s.cmd === "diskpart" || s.cmd === "format-volume" || s.cmd === "clear-disk" ||
        (s.cmd === "dd" && s.args.some((a) => /^of=\/dev\//.test(a))) ||
        (s.cmd === "format" && s.positional.some((a) => /^[a-z]:$/i.test(a))) ||
        s.redirectsOut.some((r) => /^\/dev\/(sd|disk|nvme|hd)/.test(r))) {
      out.push(hit("DES-004", undefined, excerpt));
    }
    if (s.cmd === "git") {
      const sub = s.positional[0];
      if (sub === "push" && s.args.some((a) => a === "--force" || a === "-f" || a === "--mirror" || /^\+/.test(a))) out.push(hit("DES-007", undefined, excerpt));
      if ((sub === "reset" && s.args.includes("--hard")) || (sub === "clean" && s.args.some((a) => /^-[a-z]*f/.test(a)))) out.push(hit("DES-008", undefined, excerpt));
    }

    // Secrets
    for (const secret of readsSecrets(s, ctx)) out.push(hit("SEC-004", secret, excerpt, undefined, pathTarget(secret, ctx)));
    if (isEnvDump(s) && !envDumpNarrowed(text)) out.push(hit("SEC-005", undefined, excerpt, undefined, "environment"));

    // Network uploads
    if (isNet(s)) {
      const outside = outsideHosts(s);
      for (const f of uploads(s)) {
        if (f === "-") continue; // stdin: the pipe analysis below decides
        if (isSecretPath(f, ctx) && (outside.length > 0 || segmentHosts(s).length === 0)) out.push(hit("EXF-002", `${f} to ${outside[0] ?? "an outside host"}`, excerpt));
        else if (outside.some((h) => !hostAllowed(h, allowedHosts))) out.push(hit("EXF-004", `${f} to ${outside[0]}`, excerpt));
      }
      for (const h of segmentHosts(s)) if (isDumpHost(h)) out.push(hit("EXF-001", h, excerpt));
    }

    // Privilege and persistence
    if (s.wrappers.includes("sudo") || s.wrappers.includes("doas") || ["su", "runas"].includes(s.cmd) ||
        (s.cmd === "start-process" && /-verb\s+runas/i.test(s.text))) {
      out.push(hit("PRV-001", undefined, excerpt));
    }
    const joined = s.args.join(" ").toLowerCase();
    const gitExecConfig = s.cmd === "git" && s.positional[0] === "config" && GIT_EXEC_CONFIG.test(s.positional[1] ?? "") && (s.positional.length >= 3 || s.args.some((a) => /^--(add|replace-all)$/.test(a)));
    if (gitExecConfig ||
        (s.cmd === "crontab" && !(s.args.length === 1 && s.args[0] === "-l")) ||
        (s.cmd === "launchctl" && /\b(load|bootstrap|submit|enable)\b/.test(joined)) ||
        (s.cmd === "systemctl" && /\benable\b/.test(joined)) ||
        (s.cmd === "schtasks" && /\/create\b/.test(joined)) ||
        s.cmd === "register-scheduledtask" ||
        (["reg", "new-itemproperty", "set-itemproperty"].includes(s.cmd) && /\\run\b/.test(joined))) {
      out.push(hit("PER-001", undefined, excerpt));
    }

    // Deleting or moving away sensitive things, and writing to protected places
    const removed = removalTargets(s, ctx);
    for (const t of removed) {
      if (isGuardrailOrParent(t, ctx)) out.push(hit("TAM-001", t, excerpt, undefined, pathTarget(t, ctx)));
      else if (isSensitiveToDelete(t, ctx)) out.push(hit("DES-010", t, excerpt, undefined, pathTarget(t, ctx)));
    }
    const written = writeTargets(s);
    for (const t of written) {
      if (isGuardrailPath(t, ctx)) out.push(hit("TAM-001", t, excerpt, undefined, pathTarget(t, ctx)));
      else if (isAuthorizedKeys(t, ctx)) out.push(hit("PER-002", t, excerpt, undefined, pathTarget(t, ctx)));
      else if (isInstructionPath(t, ctx)) out.push(hit("TAM-002", t, excerpt, undefined, pathTarget(t, ctx)));
      else if (isPersistencePath(t, ctx)) out.push(hit("PER-001", t, excerpt, undefined, pathTarget(t, ctx)));
    }
    // A script or tool we cannot read the effect of must not touch the guardrails unseen.
    const mention = s.cmd && removed.length === 0 && written.length === 0 && !READERS.has(s.cmd) ? GUARDRAIL_MENTION.exec(s.text) : null;
    if (mention) out.push(hit("TAM-003", clip(s.text, 80), excerpt, undefined, mention[0].toLowerCase().replace(/\\/g, "/")));

    // Supply chain
    if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "pipx"].includes(s.cmd) &&
        s.positional.some((p) => ["install", "i", "add"].includes(p))) {
      const pkgs = s.positional.slice(1);
      const badSource = pkgs.some((p) => /^(https?:|git\+|git:|github:)/i.test(p) || /^[\w.-]+\/[\w.-]+$/.test(p));
      const registryFlag = s.args.findIndex((a) => /^(--index-url|-i|--extra-index-url|--registry)(=|$)/.test(a));
      const registry = registryFlag >= 0 ? (s.args[registryFlag]!.split("=")[1] ?? s.args[registryFlag + 1] ?? "") : "";
      const badRegistry = registry !== "" && !/pypi\.org|pythonhosted\.org|registry\.npmjs\.org|registry\.yarnpkg\.com/.test(registry);
      if (badSource || badRegistry) out.push(hit("SUP-001", undefined, excerpt));
    }
  }

  // Secret content flowing into the network: `cat .env | curl ...`, `curl -d "$(cat .env)" ...`
  const pieces = text.split(/(?<!\|)\|(?!\|)/);
  for (let i = 0; i < pieces.length - 1; i++) {
    const leaks = parseSegments(pieces[i]!).some((s) => readsSecret(s, ctx) || isEnvDump(s));
    if (!leaks) continue;
    const net = pieces.slice(i + 1).flatMap((p) => parseSegments(p)).find((s) => isNet(s) && (outsideHosts(s).length > 0 || segmentHosts(s).length === 0));
    if (net) out.push(hit("EXF-003", `to ${outsideHosts(net)[0] ?? "an outside host"}`, excerpt));
  }
  // A subshell splits the command into pieces, so look for the outside host in the whole text.
  const hasOutsideNet = segs.some(isNet) && urlHosts(text).some((h) => !isLocalHost(h));
  if (hasOutsideNet) {
    for (const m of text.matchAll(/\$\(([^)]*)\)|`([^`]*)`|\(([^()]*)\)/g)) {
      const inner = m[1] ?? m[2] ?? m[3] ?? "";
      if (parseSegments(inner).some((s) => readsSecret(s, ctx) || isEnvDump(s))) out.push(hit("EXF-003", "through a subshell", excerpt));
    }
  }

  for (const h of urlHosts(text)) if (isDumpHost(h)) out.push(hit("EXF-001", h, excerpt));
  if (DUMP_URLS.some((re) => re.test(text))) out.push(hit("EXF-001", "a chat webhook", excerpt));
  if (/\b(?:nslookup|dig|host|ping)\b[^\n|;]*(?:\$\(|`)/i.test(text)) out.push(hit("EXF-005", undefined, excerpt));

  if (REMOTE_TO_SHELL.some((re) => re.test(text))) out.push(hit("EXE-001", undefined, excerpt));

  if (/\bdrop\s+(?:database|schema)\b|\bflushall\b|\bflushdb\b|\bdropdatabase\s*\(/i.test(text)) out.push(hit("DES-005", undefined, excerpt));
  if (/\bdrop\s+table\b|\btruncate\s+table\b|\bdelete\s+from\s+[\w."]+\s*(?:;|$|["'])/i.test(text)) out.push(hit("DES-006", undefined, excerpt));
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(text)) out.push(hit("DES-004", "fork bomb", excerpt));

  return out;
}

export interface CommandAnalysis {
  findings: Finding[];
  disguised: boolean;
}

export interface CommandOptions {
  allowedHosts?: string[];
  extraAskCommands?: string[];
}

// The agent's own guardrail files, named anywhere in a command, and signs the command writes to them.
const GUARDRAIL_REF = /\.claude[\\/]settings(?:\.local)?\.json|\.agentshield[\\/]|managed-settings\.json|\.cursor[\\/]hooks\.json|\.github[\\/]hooks[\\/]|\.copilot[\\/]hooks/i;
const WRITE_SIGNAL = /writeFile|appendFile|createWriteStream|\bopen\s*\([^)]*,\s*["'][wax+]|\.write\s*\(|json\.dump|\bsed\s+-i|\b(?:perl|ruby)\b[^\n]*\s-[a-z]*i|\btee\b|>\s*["']?[^\s&|>]|\bmv\b|\bcp\b|\brm\b|\bunlink|Set-Content|Add-Content|Out-File|Remove-Item|\btruncate\b|\bdd\b/i;

export function analyzeCommand(command: string, ctx: PathContext, opts: CommandOptions = {}): CommandAnalysis {
  const norm = normalizeCommand(command);
  const excerpt = clip(redactSecrets(command));
  const findings: Finding[] = [];
  // Inline code (node -e, python -c, perl -e, PowerShell) that writes the hook settings or AgentShield's files.
  if (GUARDRAIL_REF.test(command) && WRITE_SIGNAL.test(command)) findings.push(hit("TAM-001", "the agent's guardrail settings, changed from a command", excerpt));
  for (const variant of norm.variants) findings.push(...analyzeVariant(variant, ctx, excerpt, opts.allowedHosts ?? []));
  if (norm.decoded.length && EXECUTES_DECODED.test(command)) findings.push(hit("EXE-002", undefined, excerpt));
  if (norm.disguised) findings.push(hit("OBF-001", undefined, excerpt));
  const asks = (opts.extraAskCommands ?? []).map((c) => c.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
  if (asks.length) {
    for (const variant of norm.variants) {
      for (const s of parseSegments(variant)) {
        const line = [s.cmd, ...s.args].join(" ").toLowerCase();
        const match = asks.find((a) => line === a || line.startsWith(`${a} `));
        if (match) findings.push(hit("POL-001", match, excerpt));
      }
    }
  }
  return { findings: dedupe(findings), disguised: norm.disguised };
}

// ---------- Outside actions (leg C of the Rule of Two) ----------

export interface OutsideAction {
  why: string;
  /** A git push to a remote the company allows: the Rule of Two asks instead of blocking. */
  allowedRemote?: boolean;
}

export interface OutsideOptions {
  allowedHosts: string[];
  allowedRemotes: string[];
  /** Resolve a git remote name (e.g. origin) to its URL. */
  remoteUrl?: (name: string) => string | undefined;
}

/** `git@github.com:acme/app.git`, `https://github.com/acme/app.git` -> `github.com/acme/app`. */
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

export const remoteAllowed = (url: string, allowed: string[]) => {
  const r = normalizeRemote(url);
  return allowed.some((a) => r === a || r.startsWith(`${a}/`));
};

const PUBLISH: Array<[RegExp, string]> = [
  [/^(npm|pnpm|yarn|bun) publish\b/, "publishes a package"],
  [/^(twine|python3? -m twine) upload\b/, "publishes a package"],
  [/^(cargo publish|gem push|dotnet nuget push|nuget push)\b/, "publishes a package"],
  [/^(docker|podman) push\b/, "pushes an image"],
  [/^gh (gist create|release create|issue create|issue comment|pr create|pr comment|repo create|api)\b/, "posts to GitHub"],
  [/^(aws s3 (cp|sync|mv)|gsutil (cp|rsync|mv)|gcloud storage (cp|rsync|mv)|az storage blob upload|rclone (copy|sync))\b/, "copies to cloud storage"],
  [/^(kubectl (apply|delete|create|replace|patch)|helm (install|upgrade|uninstall)|terraform (apply|destroy))\b/, "changes infrastructure"],
];

export function outsideCommand(command: string, ctx: PathContext, opts: OutsideOptions): OutsideAction | undefined {
  for (const variant of normalizeCommand(command).variants) {
    for (const s of parseSegments(variant)) {
      const line = [s.cmd, ...s.args].join(" ").toLowerCase();
      if (s.cmd === "git" && s.positional[0] === "push") {
        const target = s.positional[1] ?? "origin";
        const url = /[:/]/.test(target) ? target : opts.remoteUrl?.(target);
        if (url && remoteAllowed(url, opts.allowedRemotes)) return { why: `git push to an allowed remote (${normalizeRemote(url)})`, allowedRemote: true };
        return { why: `git push to ${url ? normalizeRemote(url) : target}` };
      }
      const publish = PUBLISH.find(([re]) => re.test(line));
      if (publish) return { why: `${publish[1]}: ${clip(line, 60)}` };
      // Other gh commands read from GitHub (issues, PRs): inbound, so not an outside action.
      if (isNet(s) && s.cmd !== "gh") {
        const host = outsideHosts(s).find((h) => !hostAllowed(h, opts.allowedHosts));
        if (host) return { why: `network call to ${host}` };
      }
      for (const t of writeTargets(s)) {
        const where = classifyPath(t, ctx);
        if (where === "outside" || where === "home" || where === "system" || where === "root") return { why: `writes outside the project (${t})` };
      }
    }
  }
  return undefined;
}

/** Commands whose output is a stranger's text (leg A): fetching from the internet, reading issues. */
export function fetchesOutsideText(command: string): string | undefined {
  for (const s of parseSegments(normalizeCommand(command).variants.at(-1) ?? command)) {
    if (s.cmd === "gh" && /^(issue|pr|release|gist|api|repo|search|run)$/.test(s.positional[0] ?? "")) return "GitHub content";
    if (isNet(s)) {
      const host = outsideHosts(s)[0];
      if (host) return `content from ${host}`;
    }
  }
  return undefined;
}

/** Risky commands inside a file the agent writes (staged payloads). */
export function commandFindingsInContent(content: string, ctx: PathContext): Finding[] {
  const found: Finding[] = [];
  for (const line of content.split("\n").slice(0, 2000)) {
    if (!line.trim() || line.trim().startsWith("//")) continue;
    found.push(...analyzeCommand(line, ctx).findings.filter((f) => f.level !== "MILD"));
  }
  return dedupe(found);
}

/** What a git command is about to commit or publish: the staged changes, the whole working tree, or unpushed commits. */
export type GitGate = "staged" | "worktree" | "outgoing";

/** Which changes the hook should show the engine for this command. Empty for commands that publish nothing. */
export function gitGates(command: string): GitGate[] {
  const gates = new Set<GitGate>();
  let adds = false;
  for (const variant of normalizeCommand(command).variants) {
    for (const s of parseSegments(variant)) {
      if (s.cmd === "git") {
        const sub = s.positional[0];
        if (sub === "add") adds = true;
        if (sub === "commit" && !s.args.includes("--dry-run")) gates.add(s.args.some((a) => a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a)) ? "worktree" : "staged");
        if (sub === "push" && !s.args.includes("--dry-run") && !s.args.includes("-n")) gates.add("outgoing");
      } else if (s.cmd === "gh" && s.positional[0] === "pr" && s.positional[1] === "create") gates.add("outgoing");
    }
  }
  // `git add -A && git commit` stages in the same command: the hook sees the tree before it is staged.
  if (adds && gates.has("staged")) {
    gates.delete("staged");
    gates.add("worktree");
  }
  return [...gates];
}
