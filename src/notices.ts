// Notices: short messages the owner posts for app users ("Manual update needed", "Server maintenance").
// Stored as JSON in settings('notices'), written only by Sterling Admin, served in /v1/meta.
// Each one can target a range of app versions. The app checks every field again before showing one.
// Shared by the Worker and Sterling Admin, so both apply exactly the same rules.

export type NoticeLevel = "info" | "warn" | "bad";

export interface Notice {
  id: string;            // a-z, 0-9 and -, so the app can remember which ones were dismissed
  text: string;          // plain text, shown as is (never HTML)
  level: NoticeLevel;    // info = gold, warn = amber, bad = red
  from?: string;         // lowest app version it's for (inclusive)
  to?: string;           // highest app version it's for (inclusive)
  link?: string;         // optional button, only to Sterling's own pages
  until?: number;        // unix seconds; gone after this
}

export const MAX_NOTICES = 5;
export const MAX_NOTICE_TEXT = 240;
const RE_ID = /^[a-z0-9-]{1,24}$/;
const RE_VER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// Links may only lead to Sterling's own pages, so a notice can't send anyone somewhere else.
export const RE_LINK = /^https:\/\/(github\.com\/SterlingAddons\/|sterlingaddons\.com\/)[A-Za-z0-9._~\/?#=&%+-]{0,160}$/;
const LEVELS: NoticeLevel[] = ["info", "warn", "bad"];

function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_NOTICE_TEXT) return null;
  // No control characters, no markup characters: it's always shown as plain text anyway.
  if (/[\u0000-\u001f\u007f<>]/.test(t)) return null;
  return t;
}

export function verParts(v: string): number[] {
  return v.split(".").map(Number);
}

export function verCmp(a: string, b: string): number {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** One notice, checked. null when anything about it is off. */
export function checkNotice(v: unknown): Notice | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !RE_ID.test(o.id)) return null;
  const text = cleanText(o.text);
  if (!text) return null;
  const level = LEVELS.includes(o.level as NoticeLevel) ? (o.level as NoticeLevel) : null;
  if (!level) return null;
  const n: Notice = { id: o.id, text, level };
  for (const k of ["from", "to"] as const) {
    if (o[k] == null || o[k] === "") continue;
    if (typeof o[k] !== "string" || !RE_VER.test(o[k] as string)) return null;
    n[k] = o[k] as string;
  }
  if (n.from && n.to && verCmp(n.from, n.to) > 0) return null;
  if (o.link != null && o.link !== "") {
    if (typeof o.link !== "string" || !RE_LINK.test(o.link)) return null;
    n.link = o.link;
  }
  if (o.until != null) {
    if (typeof o.until !== "number" || !Number.isInteger(o.until) || o.until <= 0) return null;
    n.until = o.until;
  }
  return n;
}

/** The stored list, checked: bad entries and repeated ids are dropped, at most MAX_NOTICES kept. */
export function parseNotices(raw: string | null | undefined): Notice[] {
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: Notice[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const n = checkNotice(v);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    if (out.length >= MAX_NOTICES) break;
  }
  return out;
}

/** What /v1/meta hands out: everything still current. The app picks the ones for its version. */
export function activeNotices(raw: string | null | undefined, t: number): Notice[] {
  return parseNotices(raw).filter((n) => n.until == null || n.until > t);
}
