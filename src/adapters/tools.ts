// Every agent app names its tools and arguments differently (Bash / run_in_terminal / Shell / run_shell_command,
// file_path / filePath / target_file ...). The engine knows a handful of canonical tools; adapters translate into them.
// Original arguments are kept, so secret scanning still sees everything the tool was given.

export interface Canonical {
  tool: string;
  input: Record<string, unknown>;
  /** The name the agent app used, when we renamed it. */
  rawTool?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** Tool arguments arrive as an object, as a JSON string, or as something odd. Always return an object. */
export function asInput(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (isObj(parsed)) return parsed;
    } catch {
      /* not JSON: keep the text */
    }
    return { value: v };
  }
  if (isObj(v)) return v;
  if (Array.isArray(v)) return { value: v };
  return {};
}

const COMMAND = /^(bash|shell|sh|zsh|powershell|pwsh|cmd|terminal|exec|execute|local_shell|run_command|run_terminal_cmd|run_terminal_command|run_in_terminal|run_shell_command|execute_command|execute_bash|exec_command|shell_command|bash_command|terminal_command|run_bash|container_exec)$/;
const READ = /^(read|view|read_file|readfile|open_file|view_file|cat|read_many_files|read_text_file|get_file_contents|notebookread|notebook_read|read_notebook)$/;
const DELETE = /^(delete|delete_file|delete_files|remove|remove_file|rm|unlink)$/;
const WRITE = /^(write|create|edit|multiedit|multi_edit|notebookedit|notebook_edit|str_replace_editor|str_replace_based_edit_tool|str_replace|strreplace|apply_patch|applypatch|create_file|write_file|write_to_file|edit_file|replace|replace_in_file|replace_string_in_file|multi_replace_string_in_file|insert_edit_into_file|insert|update_file|patch|edit_notebook_file|create_or_update_file|file_write|file_edit|save_file)$/;
const GREP = /^(grep|rg|ripgrep|grep_search|search_file_content|search_files|search_code|search_code_subagent|semantic_search|codebase_search|search)$/;
const GLOB = /^(glob|file_search|find_files|find)$/;
const LIST = /^(ls|list|list_dir|list_directory|list_files|tree|read_directory)$/;
const FETCH = /^(webfetch|web_fetch|fetch|fetch_webpage|fetch_url|browse|browser|open_url|read_url_content|get_url)$/;
const WEB_SEARCH = /^(websearch|web_search|google_web_search|search_web|internet_search)$/;
const TASK = /^(task|agent|subagent|runsubagent|run_subagent|spawn_agent|search_subagent)$/;

const PATH_KEYS = [
  "file_path", "filePath", "filepath", "path", "file", "filename", "target_file", "targetFile", "absolute_path",
  "absolutePath", "notebook_path", "notebookPath", "uri", "target", "dir_path", "dirPath", "directory", "folder", "dir", "root",
];
const COMMAND_KEYS = ["command", "cmd", "command_line", "commandLine", "script"];
const URL_KEYS = ["url", "uri", "link", "href"];
const PATCH_KEYS = ["patch", "input", "diff", "content", "text", "command"];

/** `file:///c%3A/Users/me/a.ts` -> `c:/Users/me/a.ts`. */
export function fromFileUri(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    const path = decodeURIComponent(new URL(value).pathname);
    return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

function firstPath(input: Record<string, unknown>): string | undefined {
  for (const k of PATH_KEYS) {
    const v = str(input[k]);
    if (v) return fromFileUri(v);
  }
  return undefined;
}

function pathsFrom(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const direct = str(item);
    if (direct) out.push(fromFileUri(direct));
    else if (isObj(item)) {
      const p = firstPath(item);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Files named in a patch: `*** Update File: x`, `+++ b/x`, `diff --git a/x b/x`. */
export function patchPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(m[1]!.trim());
  for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(m[1]!.trim());
  for (const m of text.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.add(m[1]!);
  for (const m of text.matchAll(/^--- (?:a\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.add(m[1]!);
  for (const m of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    out.add(m[1]!);
    out.add(m[2]!);
  }
  return [...out];
}

function commandOf(input: Record<string, unknown>): string | undefined {
  for (const k of COMMAND_KEYS) {
    const v = input[k];
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      const parts = v as string[];
      // ["bash", "-lc", "git status"]: the script is the command.
      if (parts.length >= 3 && /^(ba|z|da|k)?sh$/.test(parts[0]!.split(/[\\/]/).pop()!) && /^-[a-z]*c$/.test(parts[1]!)) return parts[2];
      return parts.join(" ");
    }
    const s = str(v);
    if (s) return s;
  }
  return undefined;
}

/** `mcp__server__tool` for every spelling an agent app uses. */
function mcpName(raw: string, input: Record<string, unknown>): string | undefined {
  if (/^mcp__/.test(raw)) return raw;
  const cursor = /^MCP:(.+)$/i.exec(raw);
  if (cursor) return `mcp__${str(input.mcp_server_name) ?? "cursor"}__${cursor[1]}`;
  const ours = /^mcp_(?:plugin_)?agentshield(?:_agentshield)?_(.+)$/.exec(raw);
  if (ours) return `mcp__agentshield__${ours[1]}`;
  const flat = /^mcp_([^_]+)_(.+)$/.exec(raw);
  if (flat) return `mcp__${flat[1]}__${flat[2]}`;
  return undefined;
}

/** Translate one tool call into the engine's vocabulary. Unknown tools keep their name and input. */
export function canonicalize(rawTool: string, rawInput: unknown): Canonical {
  const original = asInput(rawInput);
  const input: Record<string, unknown> = { ...original };
  const name = rawTool.trim();
  const n = name.toLowerCase().replace(/[\s.-]+/g, "_");

  const mcp = mcpName(name, original);
  if (mcp) return { tool: mcp, input, ...(mcp !== name ? { rawTool: name } : {}) };

  const result = (tool: string): Canonical => ({ tool, input, ...(tool !== name ? { rawTool: name } : {}) });
  const command = commandOf(original);
  const path = firstPath(original);

  if (COMMAND.test(n) || (command && !WRITE.test(n) && !READ.test(n))) {
    if (command) input.command = command;
    return result("Bash");
  }

  if (DELETE.test(n)) {
    const paths = [...pathsFrom(original.paths), ...pathsFrom(original.files), ...pathsFrom(original.file_paths), ...pathsFrom(original.filePaths)];
    if (path) paths.unshift(path);
    if (paths[0]) input.file_path = paths[0];
    if (paths.length > 1) input.paths = [...new Set(paths)];
    return result("Delete");
  }

  if (WRITE.test(n)) {
    const paths = [
      ...pathsFrom(original.paths), ...pathsFrom(original.files), ...pathsFrom(original.file_paths), ...pathsFrom(original.filePaths),
      ...pathsFrom(original.replacements), ...pathsFrom(original.edits), ...pathsFrom(original.changes),
    ];
    for (const k of PATCH_KEYS) {
      const text = str(original[k]);
      if (text && /^\*\*\* (?:Begin Patch|Add File|Update File|Delete File)|^(?:diff --git|--- )/m.test(text)) paths.push(...patchPaths(text));
    }
    if (path) paths.unshift(path);
    const unique = [...new Set(paths)];
    if (unique[0]) input.file_path = unique[0];
    if (unique.length > 1) input.paths = unique;
    const isCreate = /create|write|new|add|save|insert/.test(n) && !/replace|edit/.test(n);
    return result(isCreate ? "Write" : "Edit");
  }

  if (READ.test(n)) {
    const paths = [...pathsFrom(original.paths), ...pathsFrom(original.files), ...pathsFrom(original.file_paths)];
    if (path) paths.unshift(path);
    if (paths[0]) input.file_path = paths[0];
    if (paths.length > 1) input.paths = [...new Set(paths)];
    return result("Read");
  }

  if (GREP.test(n) || GLOB.test(n) || LIST.test(n)) {
    if (path) input.file_path = path;
    return result(GLOB.test(n) ? "Glob" : LIST.test(n) ? "LS" : "Grep");
  }

  if (FETCH.test(n)) {
    for (const k of URL_KEYS) {
      const v = str(original[k]);
      if (v) {
        input.url = v;
        break;
      }
    }
    const urls = Array.isArray(original.urls) ? original.urls.find((u) => typeof u === "string") : undefined;
    if (!input.url && typeof urls === "string") input.url = urls;
    if (!input.url) {
      const inPrompt = /\bhttps?:\/\/[^\s"'<>)]+/i.exec(str(original.prompt) ?? str(original.query) ?? "");
      if (inPrompt) input.url = inPrompt[0];
    }
    return result("WebFetch");
  }

  if (WEB_SEARCH.test(n)) return result("WebSearch");
  if (TASK.test(n)) return result("Task");

  // Unknown tool: keep it as it is, but still expose a path or URL if it carries one, so file rules can see it.
  if (path && !input.file_path) input.file_path = path;
  return { tool: name, input };
}
