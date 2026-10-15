import { clip, dedupe, hit } from "./catalog.js";
import { redactSecrets } from "./detectors.js";
import { normalizeCommand } from "./normalize.js";
import {
  classifyPath,
  isAuthorizedKeys,
  isGuardrailPath,
  isInstructionPath,
  isPersistencePath,
  isSecretPath,
  type PathContext,
} from "./paths.js";
import type { Finding } from "./types.js";

// Shell command analysis for Bash, zsh, PowerShell and cmd.exe. Not a full parser: it splits
// statements, strips wrappers like sudo, and reads the command word, arguments and redirects.

export interface Segment {
  cmd: string;
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
        continue;
      }
    }

    const positional = args.filter((a) => !a.startsWith("-"));
    result.push({ cmd, args, positional, redirectsOut, redirectsIn, wrappers, text: part.trim() });
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

function segmentHosts(s: Segment): string[] {
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

export function readsSecret(s: Segment, ctx: PathContext): string | undefined {
  const candidates = READ_VERBS.has(s.cmd) ? [...s.positional, ...s.redirectsIn] : s.redirectsIn;
  return candidates.find((p) => isSecretPath(p, ctx));
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

function deleteTargets(s: Segment): string[] | undefined {
  if (RM_CMDS.has(s.cmd)) {
    if (!s.args.some((a) => isRecursiveFlag(s.cmd, a))) return undefined;
    return s.positional.filter((p) => !(CMD_STYLE.has(s.cmd) && /^\/[a-z]$/i.test(p)));
  }
  if (s.cmd === "find" && (s.args.includes("-delete") || /-exec\s+rm\b/.test(s.text))) return s.positional.slice(0, 1);
  return undefined;
}

// ---------- Writing ----------

const MUTATE_VERBS = new Set([
  "rm", "mv", "cp", "tee", "touch", "truncate", "ln", "chmod", "chown", "install", "move", "copy",
  "set-content", "sc", "add-content", "ac", "out-file", "remove-item", "ri", "del", "erase", "move-item", "copy-item", "new-item", "ni",
]);

function writeTargets(s: Segment): string[] {
  const targets = [...s.redirectsOut];
  if (MUTATE_VERBS.has(s.cmd)) targets.push(...s.positional);
  if ((s.cmd === "sed" || s.cmd === "perl") && s.args.some((a) => /^-i/.test(a))) targets.push(...s.positional.slice(1));
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

function analyzeVariant(text: string, ctx: PathContext, excerpt: string): Finding[] {
  const out: Finding[] = [];
  const segs = parseSegments(text);

  for (const s of segs) {
    // Deleting
    const targets = deleteTargets(s);
    for (const t of targets ?? []) {
      const where = classifyPath(t, ctx);
      if (where === "root" || where === "home" || where === "system") out.push(hit("DES-001", t, excerpt));
      else if (where === "outside" || where === "project-root") out.push(hit("DES-002", t, excerpt));
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
    const secret = readsSecret(s, ctx);
    if (secret) out.push(hit("SEC-004", secret, excerpt));
    if (isEnvDump(s)) out.push(hit("SEC-005", undefined, excerpt));

    // Network uploads
    if (isNet(s)) {
      const outside = outsideHosts(s);
      for (const f of uploads(s)) {
        if (f === "-") continue; // stdin: the pipe analysis below decides
        if (isSecretPath(f, ctx) && (outside.length > 0 || segmentHosts(s).length === 0)) out.push(hit("EXF-002", `${f} to ${outside[0] ?? "an outside host"}`, excerpt));
        else if (outside.length > 0) out.push(hit("EXF-004", `${f} to ${outside[0]}`, excerpt));
      }
      for (const h of segmentHosts(s)) if (isDumpHost(h)) out.push(hit("EXF-001", h, excerpt));
    }

    // Privilege and persistence
    if (s.wrappers.includes("sudo") || s.wrappers.includes("doas") || ["su", "runas"].includes(s.cmd) ||
        (s.cmd === "start-process" && /-verb\s+runas/i.test(s.text))) {
      out.push(hit("PRV-001", undefined, excerpt));
    }
    const joined = s.args.join(" ").toLowerCase();
    if ((s.cmd === "crontab" && !(s.args.length === 1 && s.args[0] === "-l")) ||
        (s.cmd === "launchctl" && /\b(load|bootstrap|submit|enable)\b/.test(joined)) ||
        (s.cmd === "systemctl" && /\benable\b/.test(joined)) ||
        (s.cmd === "schtasks" && /\/create\b/.test(joined)) ||
        s.cmd === "register-scheduledtask" ||
        (["reg", "new-itemproperty", "set-itemproperty"].includes(s.cmd) && /\\run\b/.test(joined))) {
      out.push(hit("PER-001", undefined, excerpt));
    }

    // Writes to protected places
    for (const t of writeTargets(s)) {
      if (isGuardrailPath(t, ctx)) out.push(hit("TAM-001", t, excerpt));
      else if (isAuthorizedKeys(t, ctx)) out.push(hit("PER-002", t, excerpt));
      else if (isInstructionPath(t, ctx)) out.push(hit("TAM-002", t, excerpt));
      else if (isPersistencePath(t, ctx)) out.push(hit("PER-001", t, excerpt));
    }

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

export function analyzeCommand(command: string, ctx: PathContext): CommandAnalysis {
  const norm = normalizeCommand(command);
  const excerpt = clip(redactSecrets(command));
  const findings: Finding[] = [];
  for (const variant of norm.variants) findings.push(...analyzeVariant(variant, ctx, excerpt));
  if (norm.decoded.length && EXECUTES_DECODED.test(command)) findings.push(hit("EXE-002", undefined, excerpt));
  if (norm.disguised) findings.push(hit("OBF-001", undefined, excerpt));
  return { findings: dedupe(findings), disguised: norm.disguised };
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
