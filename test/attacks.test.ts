// Bad-actor tests. Every attack here must fail. New ones get added as the audit finds them.
import { describe, it, expect } from "vitest";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { cleanup } from "../src/cron";
import { api, makeUser, pair, upload, newKey, newGuid, T0, env } from "./helpers";

describe("who you are comes only from the key", () =>
{
    it("refuses missing, malformed, made-up and revoked keys", async () =>
    {
        expect((await api("GET", "/v1/account")).status).toBe(401);
        expect((await api("GET", "/v1/account", null, undefined, { authorization: "Bearer short" })).status).toBe(401);
        expect((await api("GET", "/v1/account", null, undefined, { authorization: "Basic abc" })).status).toBe(401);
        expect((await api("GET", "/v1/account", newKey())).status).toBe(401);

        const u = await makeUser("Aaa");
        const pc2 = newKey();
        const link = await api("POST", "/v1/link-codes", u.key);

        await api("POST", "/v1/link-codes/redeem", pc2, { code: link.data.code });

        const pcs = (await api("GET", "/v1/account", u.key)).data.pcs;

        await api("DELETE", "/v1/keys/" + pcs.find((p: any) => !p.current).id, u.key);

        expect((await api("GET", "/v1/inbox", pc2)).status).toBe(401);
    });

    it("ignores account or GUID claims in the body", async () =>
    {
        const victim = await makeUser("Victim");
        const friend = await makeUser("Friend");

        await pair(victim, friend);

        const evil = await makeUser("Evil");
        const r = await api("GET", "/v1/inbox?since=0&account=" + victim.account, evil.key);

        expect(r.data.packets).toHaveLength(0);
    });
});

describe("stealing data", () =>
{
    it("listing someone else's GUID gets nothing", async () =>
    {
        const victim = await makeUser("Victim");
        const friend = await makeUser("Friend");

        await pair(victim, friend);
        await upload(friend, victim.guid, "SECRETFORVICTIM");

        const evil = newKey();

        await api("POST", "/v1/accounts", evil, {});
        // Evil lists both the victim's and the friend's characters on its own account.
        await api("PUT", "/v1/characters/" + victim.guid, evil, { name: "Victim", realm: "R" });
        await api("PUT", "/v1/characters/" + friend.guid, evil, { name: "Friend", realm: "R" });

        expect((await api("GET", "/v1/inbox?since=0", evil)).data.packets).toHaveLength(0);
        expect((await api("GET", "/v1/pairings", evil)).data.pairings).toHaveLength(0);
    });

    it("can't upload as someone else's character into their pairing", async () =>
    {
        const victim = await makeUser("Victim");
        const friend = await makeUser("Friend");

        await pair(victim, friend);

        const evil = newKey();

        await api("POST", "/v1/accounts", evil, {});
        await api("PUT", "/v1/characters/" + victim.guid, evil, { name: "Victim", realm: "R" });

        const r = await api("PUT", `/v1/slots/${victim.guid}/${friend.guid}`, evil, { packet: "FORGED", game_time: T0 + 999, proto: 6 });

        expect(r.status).toBe(403);
        expect((await api("GET", "/v1/inbox?since=0", friend.key)).data.packets).toHaveLength(0);
    });

    it("an evil self slot for a victim's GUID stays on the evil account", async () =>
    {
        const victim = await makeUser("Victim");
        const pc2 = newKey();
        const link = await api("POST", "/v1/link-codes", victim.key);

        await api("POST", "/v1/link-codes/redeem", pc2, { code: link.data.code });

        const evil = newKey();

        await api("POST", "/v1/accounts", evil, {});
        await api("PUT", "/v1/characters/" + victim.guid, evil, { name: "Victim", realm: "R" });

        expect((await api("PUT", `/v1/slots/${victim.guid}/${victim.guid}`, evil, { packet: "FORGED", game_time: T0, proto: 6 })).status).toBe(201);
        expect((await api("GET", "/v1/inbox?since=0", pc2)).data.packets).toHaveLength(0);
    });

    it("can't end or read someone else's pairing by id", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const pid = await pair(a, b);
        const evil = await makeUser("Evil");

        expect((await api("DELETE", "/v1/pairings/" + pid, evil.key)).status).toBe(404);
        expect((await api("GET", "/v1/pairings", a.key)).data.pairings[0].status).toBe("active");
    });

    it("can't remove another account's PC or code", async () =>
    {
        const a = await makeUser("Aaa");
        const evil = await makeUser("Evil");
        const pcs = (await api("GET", "/v1/account", a.key)).data.pcs;

        expect((await api("DELETE", "/v1/keys/" + pcs[0].id, evil.key)).status).toBe(404);

        const code = await api("POST", "/v1/pair-codes", a.key, { guid: a.guid });

        expect((await api("DELETE", "/v1/pair-codes/" + code.data.id, evil.key)).status).toBe(404);
    });
});

describe("wiping and overwriting", () =>
{
    it("an old save can't replace a newer one", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);
        await upload(a, b.guid, "NEWER", T0 + 1000);

        const r = await upload(a, b.guid, "OLDER", T0);

        expect(r.status).toBe(409);
        expect(r.data.error).toBe("stale");
        expect((await api("GET", "/v1/inbox?since=0", b.key)).data.packets[0].packet).toBe("NEWER");
    });

    it("an ended pairing can't be uploaded to or read", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const pid = await pair(a, b);

        await upload(a, b.guid, "BEFORE");
        await api("DELETE", "/v1/pairings/" + pid, a.key);

        expect((await upload(a, b.guid, "AFTER", T0 + 5)).status).toBe(403);
        expect((await api("GET", "/v1/inbox?since=0", b.key)).data.packets).toHaveLength(0);
    });

    it("a banned account is locked out and its codes stop working", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const code = (await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).data.code;

        await env.DB.prepare("UPDATE accounts SET banned = 1 WHERE id = ?1").bind(a.account).run();

        expect((await api("GET", "/v1/account", a.key)).status).toBe(403);
        expect((await api("POST", "/v1/pair-codes/redeem", b.key, { code, guid: b.guid })).status).toBe(404);
    });
});

describe("codes", () =>
{
    it("wrong, reused and expired codes all look the same", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const c = await makeUser("Ccc");

        expect((await api("POST", "/v1/pair-codes/redeem", b.key, { code: "AAAA-BBBB-CCCC", guid: b.guid })).data.error).toBe("not_found");

        const used = (await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).data.code;

        await api("POST", "/v1/pair-codes/redeem", b.key, { code: used, guid: b.guid });

        expect((await api("POST", "/v1/pair-codes/redeem", c.key, { code: used, guid: c.guid })).data.error).toBe("not_found");

        const old = await api("POST", "/v1/pair-codes", a.key, { guid: a.guid });

        await env.DB.prepare("UPDATE pair_codes SET expires_at = 1 WHERE id = ?1").bind(old.data.id).run();

        expect((await api("POST", "/v1/pair-codes/redeem", c.key, { code: old.data.code, guid: c.guid })).data.error).toBe("not_found");

        const link = await api("POST", "/v1/link-codes", a.key);

        await env.DB.prepare("UPDATE link_codes SET expires_at = 1").run();

        expect((await api("POST", "/v1/link-codes/redeem", newKey(), { code: link.data.code })).data.error).toBe("not_found");
    });

    it("codes and keys are stored hashed, never in plain text", async () =>
    {
        const a = await makeUser("Aaa");
        const code = (await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).data.code as string;
        const plain = code.replace(/-/g, "");
        const dump = JSON.stringify
        ([
            (await env.DB.prepare("SELECT * FROM pair_codes").all()).results,
            (await env.DB.prepare("SELECT * FROM keys").all()).results,
            (await env.DB.prepare("SELECT * FROM accounts").all()).results,
        ]);

        expect(dump).not.toContain(plain);
        expect(dump).not.toContain(a.key);
        expect(dump).not.toContain(a.recovery.replace(/^SQS-/, "").replace(/-/g, ""));
    });

    it("a pairing code must be redeemed for one of your own listed characters", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const code = (await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).data.code;

        expect((await api("POST", "/v1/pair-codes/redeem", b.key, { code, guid: newGuid() })).status).toBe(404);
    });
});

describe("pushing code into the game", () =>
{
    it("refuses anything outside the packet alphabet", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        for (const bad of
        [
            'x"]] os.exit() --',
            "abc\ndef",
            "abc def",
            "abc'def",
            "abc\\ndef",
            "abc[[def]]",
            "abc;",
            "STO1:1/1:abc",
        ])
        {
            expect((await upload(a, b.guid, bad)).status, bad).toBe(400);
        }
    });

    it("refuses oversized packets and bodies", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        expect((await upload(a, b.guid, "A".repeat(64 * 1024 + 1))).status).toBe(413);
        expect((await upload(a, b.guid, "A".repeat(64 * 1024))).status).toBe(201);
    });

    it("refuses odd game times and protocols", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        for (const body of
        [
            { packet: "AAA", game_time: "1794770000", proto: 6 },
            { packet: "AAA", game_time: 1.5e9 + 0.5, proto: 6 },
            { packet: "AAA", game_time: 99, proto: 6 },
            { packet: "AAA", game_time: T0, proto: -1 },
            { packet: ["AAA"], game_time: T0, proto: 6 },
        ])
        {
            expect((await api("PUT", `/v1/slots/${a.guid}/${b.guid}`, a.key, body)).status).toBe(400);
        }
    });
});

describe("SQL injection and junk input", () =>
{
    it("treats injection attempts as plain bad input", async () =>
    {
        const a = await makeUser("Aaa");

        for (const g of ["Player-1-0' OR 1=1 --", "x%27%20OR%201%3D1", "../../etc"])
        {
            const r = await api("PUT", "/v1/characters/" + encodeURIComponent(g), a.key, { name: "Aaa", realm: "R" });

            expect([400, 404]).toContain(r.status);
        }

        expect((await api("GET", "/v1/inbox?since=0%20OR%201=1", a.key)).status).toBe(400);
        expect((await api("POST", "/v1/pair-codes/redeem", a.key, "{not json")).status).toBe(400);
        expect((await api("POST", "/v1/pair-codes/redeem", a.key, [1, 2])).status).toBe(400);

        const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();

        expect(count!.n).toBeGreaterThan(0);
    });

    it("errors never echo internals", async () =>
    {
        const r = await api("GET", "/v1/nope");

        expect(r).toEqual({ status: 404, data: { error: "not_found" } });
        expect((await api("POST", "/v1/meta")).status).toBe(405);
    });
});

describe("cleanup", () =>
{
    it("expires unpaired accounts after 7 days, keeps paired ones", async () =>
    {
        const lonely = await makeUser("Lonely");
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        const old = Math.floor(Date.now() / 1000) - 8 * 86400;

        await env.DB.prepare("UPDATE accounts SET created_at = ?1 WHERE id IN (?2, ?3, ?4)").bind(old, lonely.account, a.account, b.account).run();
        await cleanup(env as any);

        expect((await api("GET", "/v1/account", lonely.key)).status).toBe(401);
        expect((await api("GET", "/v1/account", a.key)).status).toBe(200);
    });

    it("drops quest data idle 30 days and accounts idle a year", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);
        await upload(a, b.guid);

        const t = Math.floor(Date.now() / 1000);

        await env.DB.prepare("UPDATE slots SET updated_at = ?1 WHERE account_id = ?2").bind(t - 31 * 86400, a.account).run();
        await env.DB.prepare("UPDATE accounts SET last_seen = ?1 WHERE id = ?2").bind(t - 400 * 86400, b.account).run();
        await cleanup(env as any);

        expect((await api("GET", "/v1/inbox?since=0", b.key)).status).toBe(401);

        const slots = await env.DB.prepare("SELECT COUNT(*) AS n FROM slots WHERE account_id = ?1").bind(a.account).first<{ n: number }>();

        expect(slots!.n).toBe(0);
        expect((await api("GET", "/v1/pairings", a.key)).data.pairings[0]).toMatchObject({ status: "ended", ended_reason: "expired" });
    });

    it("the scheduled handler runs without analytics configured", async () =>
    {
        const ctx = createExecutionContext();

        await worker.scheduled!(createScheduledController({ scheduledTime: Date.now(), cron: "17 * * * *" }), env as any, ctx);
        await waitOnExecutionContext(ctx);
    });
});
