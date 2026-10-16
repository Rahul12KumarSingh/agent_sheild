import { claude } from "./claude.js";
import { copilot } from "./copilot.js";
import { cursor } from "./cursor.js";
import { gemini } from "./gemini.js";
import type { Adapter } from "./types.js";
import { windsurf } from "./windsurf.js";

export type { Adapter, FormatOptions, HookOutput } from "./types.js";

/** Every agent app we speak to. Order matters for detection: the most specific shapes first. */
export const ADAPTERS: Record<string, Adapter> = { claude, copilot, cursor, windsurf, gemini };

const DETECTION_ORDER: Adapter[] = [windsurf, cursor, gemini, copilot, claude];

/**
 * Pick the adapter for a payload. The hook file's own idea of the agent (`hook claude`) is only a hint:
 * one hook entry can be read by several apps (Copilot CLI, Cursor and VS Code all read .claude/settings.json),
 * and each sends its own shape. The shape wins; the hint breaks ties and covers payloads we cannot place.
 */
export function pickAdapter(hint: string | undefined, input: Record<string, unknown>): Adapter | undefined {
  const hinted = hint ? ADAPTERS[hint] : undefined;
  if (hinted?.detect(input)) return hinted;
  return DETECTION_ORDER.find((a) => a.detect(input)) ?? hinted ?? (hint === undefined || hint === "auto" ? claude : undefined);
}
