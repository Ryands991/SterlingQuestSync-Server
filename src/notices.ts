// Notices: short messages the owner posts for app users ("Manual update needed", "Server maintenance").
// Stored as JSON in settings('notices'), written only by Sterling Admin, served in /v1/meta.
// Each one can target a range of app versions. The app checks every field again before showing one.
// Shared by the Worker and Sterling Admin, so both apply exactly the same rules.

export type NoticeLevel = "info" | "warn" | "bad";

export interface Notice
{
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

// Notice text as plain, tidy text, or null if it can't be shown safely.
function cleanText(value: unknown): string | null
{
    if (typeof value !== "string") return null;

    const cleaned = value.replace(/\s+/g, " ").trim();

    if (!cleaned || cleaned.length > MAX_NOTICE_TEXT) return null;
    // No control characters, no markup characters: it's always shown as plain text anyway.
    if (/[\u0000-\u001f\u007f<>]/.test(cleaned)) return null;

    return cleaned;
}

// "0.1.25" as [0, 1, 25].
export function verParts(value: string): number[]
{
    return value.split(".").map(Number);
}

// Compares two versions: below zero, zero or above zero.
export function verCmp(a: string, b: string): number
{
    const left = verParts(a), right = verParts(b);

    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;

    return 0;
}

/** One notice, checked. null when anything about it is off. */
export function checkNotice(value: unknown): Notice | null
{
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const fields = value as Record<string, unknown>;

    if (typeof fields.id !== "string" || !RE_ID.test(fields.id)) return null;

    const text = cleanText(fields.text);

    if (!text) return null;

    const level = LEVELS.includes(fields.level as NoticeLevel) ? (fields.level as NoticeLevel) : null;

    if (!level) return null;

    const notice: Notice = { id: fields.id, text, level };

    for (const bound of ["from", "to"] as const)
    {
        if (fields[bound] == null || fields[bound] === "") continue;
        if (typeof fields[bound] !== "string" || !RE_VER.test(fields[bound] as string)) return null;

        notice[bound] = fields[bound] as string;
    }

    if (notice.from && notice.to && verCmp(notice.from, notice.to) > 0) return null;
    if (fields.link != null && fields.link !== "")
    {
        if (typeof fields.link !== "string" || !RE_LINK.test(fields.link)) return null;

        notice.link = fields.link;
    }

    if (fields.until != null)
    {
        if (typeof fields.until !== "number" || !Number.isInteger(fields.until) || fields.until <= 0) return null;

        notice.until = fields.until;
    }

    return notice;
}

/** The stored list, checked: bad entries and repeated ids are dropped, at most MAX_NOTICES kept. */
export function parseNotices(raw: string | null | undefined): Notice[]
{
    if (!raw) return [];

    let list: unknown;

    try
    {
        list = JSON.parse(raw);
    }

    catch
    {
        return [];
    }

    if (!Array.isArray(list)) return [];

    const out: Notice[] = [];
    const seen = new Set<string>();

    for (const entry of list)
    {
        const notice = checkNotice(entry);

        if (!notice || seen.has(notice.id)) continue;

        seen.add(notice.id);
        out.push(notice);

        if (out.length >= MAX_NOTICES) break;
    }

    return out;
}

/** What /v1/meta hands out: everything still current. The app picks the ones for its version. */
export function activeNotices(raw: string | null | undefined, currentTime: number): Notice[]
{
    return parseNotices(raw).filter((notice) => notice.until == null || notice.until > currentTime);
}
