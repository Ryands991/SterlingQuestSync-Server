// Small helpers: responses, randomness, hashing and input checks.

export const API_VERSION = 1;
export const MIN_APP_VERSION = "0.1.0";

// The Companion app's update feed. Apps from 0.1.26 ask this server first, so if the release files
// ever move, only this line changes and every installed app keeps updating.
export const UPDATE_FEED = "https://github.com/SterlingAddons/SterlingQuestSync-App/releases/latest/download/latest.json";

export const DAY = 86400;
export const PAIR_CODE_TTL = DAY;            // 24 hours
export const LINK_CODE_TTL = 10 * 60;        // 10 minutes
export const INVITE_TTL = DAY;
export const MAX_PARTNERS = 10;              // per character
export const MAX_CHARACTERS = 50;            // per account
export const MAX_KEYS = 10;                  // PCs per account
export const MAX_PACKET = 64 * 1024;         // characters
export const MAX_BODY = MAX_PACKET + 4096;
export const INBOX_LIMIT = 20;
export const MAX_UPLOADS_PER_DAY = 1000;     // saved uploads per account per UTC day
export const MAX_CLOCK_AHEAD = DAY;          // a save can't claim to be from further in the future

export class HttpError extends Error
{
    constructor(public status: number, public code: string)
    {
        super(code);
    }
}

// A JSON response that's never cached.
export function json(data: unknown, status = 200): Response
{
    return new Response(JSON.stringify(data),
    {
        status,
        headers:
        {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
    });
}

// Stops the request with an HTTP error code.
export function fail(status: number, code: string): never
{
    throw new HttpError(status, code);
}

// Unix time in seconds.
export function now(): number
{
    return Math.floor(Date.now() / 1000);
}

// Secure random bytes.
function randomBytes(count: number): Uint8Array
{
    const bytes = new Uint8Array(count);

    crypto.getRandomValues(bytes);

    return bytes;
}

// Secure random hex, for ids.
export function randomHex(bytes: number): string
{
    return [...randomBytes(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Codes people type: no 0/O, 1/I/L, U. 30 symbols, about 4.9 bits each (12 symbols is about 59 bits).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

// A random code from the typeable alphabet.
export function randomCode(len: number): string
{
    // Rejection sampling so every symbol is equally likely.
    const out: string[] = [];
    const max = 256 - (256 % CODE_ALPHABET.length);

    while (out.length < len)
    {
        for (const byte of randomBytes(len * 2))
        {
            if (byte < max && out.length < len) out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
        }
    }

    return out.join("");
}

// "ABCDEFGH" as "ABCD-EFGH", easier to read out.
export function groupCode(code: string): string
{
    return code.match(/.{1,4}/g)!.join("-");
}

/** Uppercase, drop dashes and spaces. Returns null if anything else is in there. */
export function normalizeCode(input: unknown, len: number): string | null
{
    if (typeof input !== "string" || input.length > 64) return null;

    const code = input.toUpperCase().replace(/[\s-]/g, "");

    if (code.length !== len) return null;

    for (const letter of code) if (!CODE_ALPHABET.includes(letter)) return null;

    return code;
}

// SHA-256 as hex, for keys and codes we never store in the clear.
export async function sha256(text: string): Promise<string>
{
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- input checks ----

export const RE_KEY = /^[A-Za-z0-9_-]{43}$/;                 // 32 random bytes, base64url
export const RE_GUID = /^Player-\d{1,5}-[0-9A-F]{8}$/;
export const RE_NAME = /^\p{L}[\p{L}' -]{0,23}$/u;
export const RE_REALM = /^[\p{L}\p{N}][\p{L}\p{N}' ()-]{0,63}$/u;
export const RE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _.'()-]{0,39}$/u;
export const RE_PACKET = /^[A-Za-z0-9()]+$/;                  // LibDeflate's print alphabet
export const RE_ID = /^[0-9a-f]{16}$/;

// A checked character GUID, or a 400.
export function guid(value: unknown): string
{
    if (typeof value !== "string" || !RE_GUID.test(value)) fail(400, "bad_guid");

    return value;
}

// A checked PC label, or the fallback when none is given.
export function label(value: unknown, fallback = "PC"): string
{
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string") fail(400, "bad_label");

    const trimmed = value.trim();

    if (!RE_LABEL.test(trimmed)) fail(400, "bad_label");

    return trimmed;
}

// A checked row id; anything else is simply not found.
export function id(value: unknown): string
{
    if (typeof value !== "string" || !RE_ID.test(value)) fail(404, "not_found");

    return value;
}

/** Reads the body, stopping as soon as it passes the cap (a missing or false Content-Length can't get around it). */
async function readCapped(req: Request): Promise<string>
{
    if (!req.body) return "";

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;)
    {
        const { done, value } = await reader.read();

        if (done) break;

        total += value.byteLength;

        if (total > MAX_BODY * 4) // 4 bytes per character at most
        {
            await reader.cancel();

            fail(413, "too_large");
        }

        chunks.push(value);
    }

    const all = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks)
    {
        all.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(all);
}

/** A path part, percent-decoded. Broken escapes are plain bad input, not a server error. */
export function pathPart(raw: string): string
{
    try
    {
        return decodeURIComponent(raw);
    }

    catch
    {
        fail(400, "bad_path");
    }
}

// The body as a JSON object, within the size cap.
export async function readJson(req: Request): Promise<Record<string, unknown>>
{
    const len = Number(req.headers.get("content-length") || "0");

    if (len > MAX_BODY) fail(413, "too_large");

    const text = await readCapped(req);

    if (text.length > MAX_BODY) fail(413, "too_large");
    if (text === "") return {};

    try
    {
        const parsed = JSON.parse(text);

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    }

    catch
    {
        // fall through
    }

    fail(400, "bad_json");
}

// The key from the Authorization header, or a 401.
export function bearer(req: Request): string
{
    const header = req.headers.get("authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);

    if (!match) fail(401, "unauthorized");

    return match[1];
}
