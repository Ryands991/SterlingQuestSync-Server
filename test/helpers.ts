import { SELF, env } from "cloudflare:test";

export const BASE = "https://sync.test";

let guidCounter = 0x100000;

export function newKey(): string
{
    const b = new Uint8Array(32);

    crypto.getRandomValues(b);

    let s = btoa(String.fromCharCode(...b));

    return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newGuid(): string
{
    guidCounter += 1;

    return "Player-6800-" + guidCounter.toString(16).toUpperCase().padStart(8, "0");
}

export async function api(method: string, path: string, key?: string | null, body?: unknown, headers: Record<string, string> = {})
{
    const h: Record<string, string> = { ...headers };

    if (key) h.authorization = "Bearer " + key;
    if (body !== undefined) h["content-type"] = "application/json";

    const res = await SELF.fetch(BASE + path,
    {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });

    let data: any = null;
    const text = await res.text();

    try { data = JSON.parse(text); } catch { data = text; }

    return { status: res.status, data };
}

export interface User
{
    key: string;
    account: string;
    recovery: string;
    guid: string;
    name: string;
}

export async function makeUser(name: string, realm = "CAMWOW US2 Realm 2 PvP"): Promise<User>
{
    const key = newKey();
    const r = await api("POST", "/v1/accounts", key, { label: "Desktop" });

    if (r.status !== 201) throw new Error("signup failed " + JSON.stringify(r));

    const g = newGuid();
    const c = await api("PUT", "/v1/characters/" + g, key, { name, realm });

    if (c.status !== 200) throw new Error("character failed " + JSON.stringify(c));

    return { key, account: r.data.account_id, recovery: r.data.recovery_code, guid: g, name };
}

export async function pair(a: User, b: User): Promise<string>
{
    const code = await api("POST", "/v1/pair-codes", a.key, { guid: a.guid });

    if (code.status !== 201) throw new Error("code failed " + JSON.stringify(code));

    const r = await api("POST", "/v1/pair-codes/redeem", b.key, { code: code.data.code, guid: b.guid });

    if (r.status !== 201) throw new Error("redeem failed " + JSON.stringify(r));

    return r.data.pairing_id;
}

export const PACKET = "STO1abcXYZ0123(456)";
export const T0 = 1_794_770_000;

export async function upload(u: User, to: string, packet = PACKET, gameTime = T0, from = u.guid)
{
    return api("PUT", `/v1/slots/${from}/${to}`, u.key, { packet, game_time: gameTime, proto: 6 });
}

export { env };
