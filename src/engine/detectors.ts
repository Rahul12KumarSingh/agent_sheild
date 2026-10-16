import { clip, hit } from "./catalog.js";
import { MAX_SCAN } from "./normalize.js";
import type { Finding } from "./types.js";

// ---------- Secrets ----------

interface SecretPattern {
  type: string;
  re: RegExp;
  /** Capture group holding the secret value, when the match includes a label. */
  group?: number;
  /** What a safer prompt uses instead of the value. */
  placeholder: string;
}

// Order matters: earlier patterns win when matches overlap (sk-ant- before sk-).
const SECRET_PATTERNS: SecretPattern[] = [
  { type: "PRIVATE_KEY", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g, placeholder: "<path to your key file>" },
  { type: "AWS_ACCESS_KEY", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, placeholder: "$AWS_ACCESS_KEY_ID" },
  { type: "AWS_SECRET_KEY", re: /aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi, group: 1, placeholder: "$AWS_SECRET_ACCESS_KEY" },
  { type: "GITHUB_TOKEN", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, placeholder: "$GITHUB_TOKEN" },
  { type: "GOOGLE_API_KEY", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, placeholder: "$GOOGLE_API_KEY" },
  { type: "SLACK_TOKEN", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, placeholder: "$SLACK_TOKEN" },
  { type: "STRIPE_KEY", re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g, placeholder: "$STRIPE_SECRET_KEY" },
  { type: "ANTHROPIC_KEY", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, placeholder: "$ANTHROPIC_API_KEY" },
  { type: "OPENAI_KEY", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, placeholder: "$OPENAI_API_KEY" },
];

/** Documentation examples and obvious placeholders are not live secrets. */
const PLACEHOLDER = /example|x{4,}|0{8,}|your|dummy|redacted|\.\.\./i;

export interface SecretMatch {
  type: string;
  value: string;
  index: number;
  placeholder: string;
}

export function findSecrets(text: string): SecretMatch[] {
  const t = text.slice(0, MAX_SCAN);
  const found: SecretMatch[] = [];
  for (const p of SECRET_PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      const value = p.group ? (m[p.group] ?? "") : m[0];
      const index = (m.index ?? 0) + (p.group ? m[0].indexOf(value) : 0);
      if (!value || PLACEHOLDER.test(value)) continue;
      if (found.some((f) => index < f.index + f.value.length && f.index < index + value.length)) continue;
      found.push({ type: p.type, value, index, placeholder: p.placeholder });
    }
  }
  return found;
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g;

export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, "[REDACTED:PRIVATE_KEY]");
  for (const s of findSecrets(out)) out = out.split(s.value).join(`[REDACTED:${s.type}]`);
  return out;
}

// ---------- Personal and financial data ----------

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 8, 7, 0, 6], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar numbers carry a Verhoeff check digit. */
export function verhoeff(digits: string): boolean {
  let c = 0;
  const rev = [...digits].reverse();
  for (let i = 0; i < rev.length; i++) c = VD[c]![VP[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

export interface PiiMatch {
  type: "CARD" | "AADHAAR" | "PAN" | "EMAIL";
  value: string;
}

export function findPII(text: string): PiiMatch[] {
  let t = text.slice(0, MAX_SCAN);
  const out: PiiMatch[] = [];
  for (const m of t.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && /^[3-6]/.test(digits) && !/^(\d)\1+$/.test(digits) && luhn(digits)) {
      out.push({ type: "CARD", value: m[0] });
      t = t.replace(m[0], " ".repeat(m[0].length)); // so the Aadhaar check does not see a card fragment
    }
  }
  for (const m of t.matchAll(/\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g)) {
    if (verhoeff(m[0].replace(/\D/g, ""))) out.push({ type: "AADHAAR", value: m[0] });
  }
  for (const m of t.matchAll(/\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g)) out.push({ type: "PAN", value: m[0] });
  for (const m of t.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) out.push({ type: "EMAIL", value: m[0] });
  return out;
}

const PII_RULE = { CARD: "PII-001", AADHAAR: "PII-002", PAN: "PII-003", EMAIL: "PII-004" } as const;
const PII_PLACEHOLDER = { CARD: "<CARD_NUMBER>", AADHAAR: "<AADHAAR>", PAN: "<PAN>", EMAIL: "user@example.com" } as const;
const PII_PACK = { CARD: "card", AADHAAR: "aadhaar", PAN: "pan", EMAIL: "email" } as const;

/** Published test card numbers from payment providers' documentation. */
const TEST_CARDS = new Set([
  "4111111111111111", "4242424242424242", "4012888888881881", "4000056655665556", "5555555555554444",
  "5105105105105100", "2223003122003222", "378282246310005", "371449635398431", "6011111111111117", "3530111333300000",
]);

export interface PiiOptions {
  packs?: readonly string[];
  allowTestData?: boolean;
}

export function filterPII(matches: PiiMatch[], opts: PiiOptions = {}): PiiMatch[] {
  return matches.filter(
    (p) => (!opts.packs || opts.packs.includes(PII_PACK[p.type])) && !(opts.allowTestData && p.type === "CARD" && TEST_CARDS.has(p.value.replace(/\D/g, ""))),
  );
}

export function piiFindings(text: string, opts: PiiOptions = {}): Finding[] {
  return filterPII(findPII(text), opts).map((p) => hit(PII_RULE[p.type]));
}

/** For logs and the console: secrets and personal data replaced by labels. */
export function redactAll(text: string): string {
  let out = redactSecrets(text);
  for (const p of findPII(out)) if (p.type !== "EMAIL") out = out.split(p.value).join(`[REDACTED:${p.type}]`);
  return out;
}

export interface Span {
  start: number;
  end: number;
  label: string;
}

/** Character ranges worth highlighting in Prompt Coach. Never overlapping, sorted. */
export function riskySpans(text: string, opts: PiiOptions = {}): Span[] {
  const t = text.slice(0, MAX_SCAN);
  const spans: Span[] = [];
  for (const s of findSecrets(t)) spans.push({ start: s.index, end: s.index + s.value.length, label: s.type });
  for (const m of t.matchAll(PRIVATE_KEY_BLOCK)) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, label: "PRIVATE_KEY" });
  for (const p of filterPII(findPII(t), opts)) {
    let from = 0;
    for (;;) {
      const i = t.indexOf(p.value, from);
      if (i < 0) break;
      spans.push({ start: i, end: i + p.value.length, label: p.type });
      from = i + p.value.length;
    }
  }
  for (const re of [...INJECTION_PHRASES, EXFIL_INSTRUCTION]) {
    const m = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`).exec(t);
    if (m) spans.push({ start: m.index, end: m.index + m[0].length, label: "INSTRUCTION" });
  }
  for (const m of t.matchAll(/\bhttps?:\/\/[^\s'"`)]+/gi)) {
    const host = /^https?:\/\/(?:[^@\s/]+@)?([^/\s:?#]+)/i.exec(m[0])?.[1]?.toLowerCase() ?? "";
    if (DUMP_HOST_HINT.test(host)) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, label: "DUMP_SITE" });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of spans) if (!out.length || s.start >= out.at(-1)!.end) out.push(s);
  return out;
}

const DUMP_HOST_HINT = /(^|\.)(webhook\.site|requestbin\.(net|com)|pipedream\.net|pastebin\.com|transfer\.sh|ngrok(-free)?\.(io|app)|hookbin\.com|beeceptor\.com|file\.io|0x0\.st|interact\.sh|oast\.\w+)$/;

/** The safer prompt: secrets and personal data replaced by placeholders. */
export function rewritePrompt(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, "<path to your key file>");
  for (const s of findSecrets(out)) out = out.split(s.value).join(s.placeholder);
  for (const p of findPII(out)) if (p.type !== "EMAIL") out = out.split(p.value).join(PII_PLACEHOLDER[p.type]);
  return out;
}

// ---------- Prompt injection in content the agent reads ----------

const INJECTION_PHRASES: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|original)\s+(?:instructions|prompts?|directions|rules)/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+\w+/i,
  /\bforget\s+(?:all\s+)?(?:your|the|previous)\s+(?:instructions|rules)/i,
  /\b(?:new|updated|real)\s+(?:system\s+)?instructions\s*:/i,
  /<\|im_start\|>|\[INST\]|<\/?system>/i,
  /\b(?:ai|llm)\s+(?:agents?|assistants?|models?)\s*[:,]\s*(?:please\s+)?(?:you\s+must|ignore|run|execute|send|upload|post|read|copy|before)\b/i,
  /\b(?:assistant|agent|claude|copilot|cursor)\s*[:,]\s*(?:please\s+)?(?:you\s+must|ignore|run|execute|send|upload|post|copy)\b/i,
  /\bdo\s+not\s+(?:tell|inform|alert|mention\s+(?:this\s+)?to)\s+the\s+user\b/i,
  /\bbefore\s+(?:you\s+)?(?:start|continue|proceed|doing\s+anything(?:\s+else)?)\s*,?\s+(?:first\s+)?(?:copy|send|upload|post|read|run|execute|cat)\b/i,
];

const EXFIL_INSTRUCTION =
  /\b(?:send|post|upload|copy|exfiltrate|transmit|forward|curl|paste)\b[^.\n]{0,80}?(?:\.env\b|credentials|secrets?\b|api[\s_-]?keys?|tokens?\b|passwords?|ssh\s+keys?|id_rsa)[^\n]{0,120}?(?:https?:\/\/|webhook|endpoint|\burl\b)/i;

const hasPhrase = (s: string) => INJECTION_PHRASES.some((re) => re.test(s));

export function injectionFindings(text: string): Finding[] {
  const t = text.slice(0, MAX_SCAN);
  const out: Finding[] = [];

  // Invisible Unicode "tag" characters spell out ASCII that the user cannot see.
  let hidden = "";
  for (const m of t.matchAll(/[\u{E0000}-\u{E007F}]+/gu)) {
    const chars = [...m[0]];
    if (chars.length >= 3) hidden += `${chars.map((c) => String.fromCodePoint(c.codePointAt(0)! - 0xe0000)).join("")} `;
  }
  if (hidden) out.push(hit("INJ-002", "invisible Unicode tag characters", clip(hidden)));

  // Zero-width characters splitting ASCII words (emoji and Indic scripts use them legitimately between non-ASCII letters).
  const zwSplit = /([A-Za-z])[​‌‍⁠﻿]+(?=[A-Za-z])/g;
  const unsplit = t.replace(zwSplit, "$1");
  const comments = [...t.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1] ?? "").join("\n");

  if (hasPhrase(comments) || hasPhrase(hidden) || (unsplit !== t && hasPhrase(unsplit) && !hasPhrase(t))) {
    out.push(hit("INJ-002", "instructions hidden in a comment or invisible text", clip(comments || hidden || unsplit)));
  } else if (hasPhrase(t)) {
    const re = INJECTION_PHRASES.find((r) => r.test(t))!;
    out.push(hit("INJ-001", undefined, clip(re.exec(t)?.[0] ?? "")));
  }

  for (const s of [unsplit, hidden]) {
    const m = EXFIL_INSTRUCTION.exec(s);
    if (m) {
      out.push(hit("INJ-003", undefined, clip(m[0])));
      break;
    }
  }

  if (/[‪-‮⁦-⁩]/.test(t)) out.push(hit("INJ-004"));
  return out;
}
