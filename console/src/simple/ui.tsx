import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Action, CustomRule, ShieldRecord } from "../types";

// Shared by the local settings page and the public console: one design system.

export const ICONS = {
  shield: "M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6l-7-3Z",
  shieldCheck: "M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6l-7-3Zm-1.2 12.2-3-3 1.4-1.4 1.6 1.6 3.8-3.8 1.4 1.4-5.2 5.2Z",
  key: "M14.5 3a6.5 6.5 0 0 0-6.2 8.5L3 16.8V21h4.2v-2h2v-2h2l1.3-1.3A6.5 6.5 0 1 0 14.5 3Zm1.5 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z",
  file: "M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V8h4.5L13 3.5Z",
  upload: "M12 3 6.5 8.5l1.4 1.4L11 6.8V16h2V6.8l3.1 3.1 1.4-1.4L12 3ZM4 18v3h16v-3h-2v1H6v-1H4Z",
  trash: "M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z",
  download: "M11 3h2v9.2l3.1-3.1 1.4 1.4L12 16l-5.5-5.5 1.4-1.4 3.1 3.1V3ZM4 18h16v3H4v-3Z",
  eyeOff: "M3.3 2 2 3.3l3.2 3.2A11 11 0 0 0 1 12c1.7 4.4 6 7.5 11 7.5 1.9 0 3.7-.4 5.3-1.2l3.4 3.4L22 20.4 3.3 2ZM12 17a5 5 0 0 1-4.6-7l1.6 1.6a3 3 0 0 0 3.4 3.4L14 16.6c-.6.3-1.3.4-2 .4Zm11-5c-.8 2-2.1 3.8-3.8 5.1l-2.3-2.3A5 5 0 0 0 10.2 8l-2-2a11 11 0 0 1 3.8-.6c5 0 9.3 3.1 11 7.5Z",
  lock: "M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z",
  check: "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7 9.5 16.2Z",
  alert: "M12 3 2 20h20L12 3Zm-1 6h2v5h-2V9Zm0 7h2v2h-2v-2Z",
  spark: "M12 2l2.1 6 6 2.1-6 2.1L12 18.3l-2.1-6.1-6-2.1 6-2.1L12 2Zm7 13 .9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z",
  terminal: "M3 5h18v14H3V5Zm2 2v10h14V7H5Zm1.6 2.4L9.2 12l-2.6 2.6L8 16l4-4-4-4-1.4 1.4ZM12 15h5v1.5h-5V15Z",
  link: "M10.6 13.4a1 1 0 0 1 0-1.4l3-3a3 3 0 1 1 4.2 4.2l-1.5 1.5-1.4-1.4 1.5-1.5a1 1 0 0 0-1.4-1.4l-3 3a1 1 0 0 1-1.4 0Zm2.8-2.8a1 1 0 0 1 0 1.4l-3 3a3 3 0 1 1-4.2-4.2l1.5-1.5 1.4 1.4-1.5 1.5a1 1 0 1 0 1.4 1.4l3-3a1 1 0 0 1 1.4 0Z",
  refresh: "M17.6 6.4A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4l-2.4 2.4Z",
  play: "M8 5v14l11-7L8 5Z",
  copy: "M8 3h10a2 2 0 0 1 2 2v12h-2V5H8V3ZM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z",
  user: "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5Z",
  bot: "M11 2h2v3h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4V2ZM8.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-3a15 15 0 0 0-1.3-4 8 8 0 0 1 4.3 4ZM12 4c.8 1.1 1.5 2.5 1.9 4h-3.8C10.5 6.5 11.2 5.1 12 4ZM4.3 14a8 8 0 0 1 0-4h3.4a16 16 0 0 0 0 4H4.3Zm.8 2h3a15 15 0 0 0 1.3 4 8 8 0 0 1-4.3-4Zm3-8h-3a8 8 0 0 1 4.3-4 15 15 0 0 0-1.3 4ZM12 20c-.8-1.1-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.9-1.9 4Zm2.3-6H9.7a14 14 0 0 1 0-4h4.6a14 14 0 0 1 0 4Zm.3 6a15 15 0 0 0 1.3-4h3a8 8 0 0 1-4.3 4Zm1.7-6a16 16 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4Z",
  hand: "M9 2a1.5 1.5 0 0 1 1.5 1.5V11h1V2.5a1.5 1.5 0 0 1 3 0V11h1V4.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-12.6 4.2L3 14.2a1.5 1.5 0 0 1 2.3-1.9L7.5 15V3.5A1.5 1.5 0 0 1 9 2Z",
  arrow: "M13 5l7 7-7 7-1.4-1.4 4.6-4.6H4v-2h12.2l-4.6-4.6L13 5Z",
  package: "M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.4 3.5L12 11.3 5.6 7.8 12 4.3ZM5 9.5l6 3.3v6.6l-6-3.3V9.5Zm8 9.9v-6.6l6-3.3v6.6l-6 3.3Z",
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="s-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d={ICONS[name]} fill="currentColor" />
    </svg>
  );
}

export const ACTION_WORD: Record<Action, string> = { block: "Stopped", ask: "Paused for you", note: "Flagged", allow: "Allowed" };

export function Pill({ action, children }: { action: Action | "on"; children?: ReactNode }) {
  const cls = action === "on" ? "s-allow" : action === "note" ? "s-flag" : `s-${action}`;
  return <span className={`s-pill ${cls}`}>{children ?? ACTION_WORD[action as Action]}</span>;
}

export const shortPaths = (s: string) =>
  s
    .replace(/(?:\/Users|\/home)\/[^/\s"']+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "~")
    .replace(/(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/"']+){4,}/g, (p) => `…/${p.split(/[\\/]/).slice(-2).join("/")}`);

export const cleanReason = (r: string) => shortPaths(r.replace(/\s*\(\+\d+ more:[^)]*\)$/, ""));

export function toolLabel(r: ShieldRecord): string {
  if (r.kind === "prompt") return "Prompt";
  const t = (r.tool ?? "").toLowerCase();
  const base = /bash|shell|powershell|terminal/.test(t) ? "Command" : /^read|view/.test(t) ? "Read file" : /write|edit|create/.test(t) ? "Edit file" : /fetch|search|web/.test(t) ? "Web" : /^(glob|grep|ls)/.test(t) ? "Search" : t.startsWith("mcp__") ? "Tool" : r.tool ?? "Action";
  return r.kind === "result" ? `${base} output` : base;
}

export function timeAgo(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** One line a person can read: "Block commands starting with “terraform destroy”". */
export function describeRule(r: CustomRule): string {
  const verb = r.action === "block" ? "Block" : "Ask before";
  const list = r.patterns.map((p) => `“${p}”`).join(", ");
  switch (r.kind) {
    case "command":
      return `${verb} commands starting with ${list}`;
    case "path":
      return `${verb} ${r.on?.length === 1 ? (r.on[0] === "read" ? "reading" : "changing") : "reading or changing"} files matching ${list}`;
    case "host":
      return `${verb} anything that contacts ${list}`;
    case "text":
      return `${verb} commands or prompts matching ${list}`;
  }
}

/** Animates a number up to its value when it first appears or changes. */
export function useCountUp(value: number, ms = 700): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - (1 - p) ** 3;
      setShown(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

export function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} className={`s-toggle${value ? " on" : ""}`} disabled={disabled} onClick={() => onChange(!value)}>
      <span className="s-toggle-thumb" />
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="s-btn s-btn-ghost s-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} /> {done ? "Copied" : label}
    </button>
  );
}
