// Undo common command disguises so the rules see what will really run.
// We keep every variant (original, unquoted, decoded) and run the rules on all of them.

export const MAX_SCAN = 100_000;

export interface Normalized {
  variants: string[];
  /** Payloads recovered from base64 or PowerShell -EncodedCommand. */
  decoded: string[];
  disguised: boolean;
}

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const SEGMENT_SPLIT = /\|\||&&|[;|\n()`]|\$\(/;
const B64_TOKEN = /[A-Za-z0-9+/]{8,}={0,2}/g;

function printable(s: string): boolean {
  if (!s) return false;
  const bad = s.replace(/[\x09\x0A\x0D\x20-\x7E]/g, "").length;
  return bad / s.length < 0.05;
}

function decodePayloads(text: string): string[] {
  const out: string[] = [];
  if (/base64|frombase64string|certutil/i.test(text)) {
    for (const m of text.matchAll(B64_TOKEN)) {
      const s = Buffer.from(m[0], "base64").toString("utf8");
      if (printable(s)) out.push(s);
    }
  }
  const enc = /(?:^|\s)-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+([A-Za-z0-9+/]{8,}={0,2})/gi;
  for (const m of text.matchAll(enc)) {
    const s = Buffer.from(m[1] ?? "", "base64").toString("utf16le");
    if (printable(s)) out.push(s);
  }
  return out;
}

/** A quote, escape or backtick inside the command word itself, e.g. r""m, 'r'm, r\m, Re`move-Item. */
function commandWordDisguised(text: string): boolean {
  for (const part of text.split(SEGMENT_SPLIT)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const first = tokens.find((t) => !/^(sudo|doas|nohup|time|command|exec|&|\.|[A-Za-z_]\w*=.*)$/.test(t));
    // Outer quotes are normal ("C:\Program Files\x.exe", or the tail of a quoted subshell).
    const word = first?.replace(/^["']+|["']+$/g, "");
    if (!word) continue;
    if (/^[a-zA-Z]:\\/.test(word) || /^\.?\\/.test(word)) continue; // a Windows path to a program
    if (/["'\\]/.test(word)) return true;
  }
  return false;
}

export function normalizeCommand(command: string): Normalized {
  const original = command.slice(0, MAX_SCAN);
  let t = original;
  let disguised = false;

  if (/[​-‍⁠﻿]/.test(t)) {
    t = t.replace(ZERO_WIDTH, "");
    disguised = true;
  }
  if (/\$\{IFS\}|\$IFS\b/.test(t)) {
    t = t.replace(/\$\{IFS\}|\$IFS\b/g, " ");
    disguised = true;
  }
  if (/['"]\s*\+\s*['"]/.test(t)) {
    t = t.replace(/['"]\s*\+\s*['"]/g, ""); // PowerShell string concatenation: 'Remove-'+'Item'
    disguised = true;
  }
  const callOperator = /&\s*\(\s*(["']?)([\w.-]+)\1\s*\)/g; // PowerShell: & ('Remove-Item') -> & Remove-Item
  if (callOperator.test(t)) {
    t = t.replace(callOperator, "& $2");
    disguised = true;
  }
  if (/\w`\w/.test(t)) {
    t = t.replace(/(\w)`(?=\w)/g, "$1"); // PowerShell escape: Re`move-Item
    disguised = true;
  }
  const wordDisguised = commandWordDisguised(t);
  if (wordDisguised) disguised = true;

  const unquoted = t.replace(/["']/g, "");
  const variants = [original, t, unquoted];
  if (wordDisguised) variants.push(unquoted.replace(/\\(?=[A-Za-z])/g, "")); // r\m -> rm

  const decoded = decodePayloads(t);
  if (decoded.length) disguised = true;
  for (const d of decoded) variants.push(d, d.replace(/["']/g, ""));

  return { variants: [...new Set(variants)], decoded, disguised };
}
