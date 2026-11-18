import { describe, it, expect } from "vitest";
import { api, makeUser, pair, upload, newKey, newGuid, PACKET, T0, env } from "./helpers";

describe("meta and sign-up", () =>
{
    it("answers meta without a key", async () =>
    {
        const r = await api("GET", "/v1/meta");

        expect(r.status).toBe(200);
        expect(r.data).toMatchObject({ api: 1, signups: "open" });
    });

    it("makes an account and shows a recovery code once", async () =>
    {
        const key = newKey();
        const r = await api("POST", "/v1/accounts", key, { label: "Desktop" });

        expect(r.status).toBe(201);
        expect(r.data.recovery_code).toMatch(/^SQS-[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);

        const me = await api("GET", "/v1/account", key);

        expect(me.status).toBe(200);
        expect(me.data.pcs).toHaveLength(1);
        expect(me.data.pcs[0]).toMatchObject({ label: "Desktop", current: true });
        expect(JSON.stringify(me.data)).not.toContain("recovery");
    });

    it("refuses the same key twice", async () =>
    {
        const key = newKey();

        expect((await api("POST", "/v1/accounts", key, {})).status).toBe(201);
        expect((await api("POST", "/v1/accounts", key, {})).status).toBe(409);
    });

    it("checks character names, realms and GUIDs", async () =>
    {
        const u = await makeUser("Kaelith Emberfall");

        expect((await api("PUT", "/v1/characters/Player-6800-0000A11C", u.key, { name: "Kaelith Emberfall", realm: "CAMWOW US2 Realm 2 PvP" })).status).toBe(200);
        expect((await api("PUT", "/v1/characters/not-a-guid", u.key, { name: "X", realm: "R" })).status).toBe(400);
        expect((await api("PUT", "/v1/characters/" + newGuid(), u.key, { name: "<script>", realm: "R" })).status).toBe(400);
        expect((await api("PUT", "/v1/characters/" + newGuid(), u.key, { name: "Tovak Stoneroot", realm: "Realm'; DROP TABLE x" })).status).toBe(400);
    });
});

describe("pairing", () =>
{
    it("pairs two characters and hands each side its keys", async () =>
    {
        const kael = await makeUser("Kaelith Emberfall");
        const bran = await makeUser("Brannoc Ashvale");

        await pair(kael, bran);

        const a = await api("GET", "/v1/pairings", kael.key);
        const b = await api("GET", "/v1/pairings", bran.key);

        expect(a.data.pairings).toHaveLength(1);
        expect(a.data.pairings[0]).toMatchObject({ my_guid: kael.guid, partner_guid: bran.guid, partner_name: "Brannoc Ashvale", status: "active" });
        expect(a.data.pairings[0].my_key).toBe(b.data.pairings[0].partner_key);
        expect(a.data.pairings[0].partner_key).toBe(b.data.pairings[0].my_key);
    });

    it("peek shows who the code is for before anything is shared", async () =>
    {
        const kael = await makeUser("Kaelith Emberfall");
        const bran = await makeUser("Brannoc Ashvale");
        const code = await api("POST", "/v1/pair-codes", kael.key, { guid: kael.guid });
        const peek = await api("POST", "/v1/pair-codes/peek", bran.key, { code: code.data.code, guid: bran.guid });

        expect(peek.data).toMatchObject({ partner: { name: "Kaelith Emberfall" }, already_paired: false, different_install: false });
        expect((await api("GET", "/v1/pairings", bran.key)).data.pairings).toHaveLength(0);
    });

    it("codes work with lowercase and without dashes, once", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const c = await makeUser("Ccc");
        const code = (await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).data.code as string;
        const sloppy = code.toLowerCase().replace(/-/g, " ");

        expect((await api("POST", "/v1/pair-codes/redeem", b.key, { code: sloppy, guid: b.guid })).status).toBe(201);
        expect((await api("POST", "/v1/pair-codes/redeem", c.key, { code, guid: c.guid })).status).toBe(404);
    });

    it("can't redeem your own code", async () =>
    {
        const a = await makeUser("Aaa");
        const code = (await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).data.code;

        expect((await api("POST", "/v1/pair-codes/redeem", a.key, { code, guid: a.guid })).status).toBe(409);
    });

    it("allows several open codes but never more than the partner slots left", async () =>
    {
        const a = await makeUser("Aaa");

        for (let i = 0; i < 10; i++) expect((await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).status).toBe(201);

        expect((await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).status).toBe(409);

        const list = await api("GET", "/v1/pair-codes", a.key);

        expect(list.data.codes).toHaveLength(10);
        expect(JSON.stringify(list.data)).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/); // codes are never shown again
        expect((await api("DELETE", "/v1/pair-codes/" + list.data.codes[0].id, a.key)).status).toBe(200);
        expect((await api("POST", "/v1/pair-codes", a.key, { guid: a.guid })).status).toBe(201);
    });

    it("enforces 10 partners per character", async () =>
    {
        const hub = await makeUser("Hub");

        for (let i = 0; i < 10; i++) await pair(hub, await makeUser("Friend" + String.fromCharCode(97 + i)));

        const late = await makeUser("Late");
        const code = await api("POST", "/v1/pair-codes", late.key, { guid: late.guid });

        expect((await api("POST", "/v1/pair-codes/redeem", hub.key, { code: code.data.code, guid: hub.guid })).status).toBe(409);
    });

    it("warns about a different install and only replaces when asked", async () =>
    {
        const kael = await makeUser("Kaelith Emberfall");
        const tovak = await makeUser("Tovak Stoneroot");

        await pair(kael, tovak);

        // Tovak reinstalls: new account, same character GUID.
        const tovak2key = newKey();

        await api("POST", "/v1/accounts", tovak2key, {});
        await api("PUT", "/v1/characters/" + tovak.guid, tovak2key, { name: "Tovak Stoneroot", realm: "CAMWOW US2 Realm 2 PvP" });

        const code = (await api("POST", "/v1/pair-codes", tovak2key, { guid: tovak.guid })).data.code;
        const peek = await api("POST", "/v1/pair-codes/peek", kael.key, { code, guid: kael.guid });

        expect(peek.data.different_install).toBe(true);
        expect((await api("POST", "/v1/pair-codes/redeem", kael.key, { code, guid: kael.guid })).data.error).toBe("different_install");

        const r = await api("POST", "/v1/pair-codes/redeem", kael.key, { code, guid: kael.guid, replace: true });

        expect(r.status).toBe(201);

        // The old install now sees its pairing ended as "replaced", with no keys.
        const old = await api("GET", "/v1/pairings", tovak.key);

        expect(old.data.pairings[0]).toMatchObject({ status: "ended", ended_reason: "replaced", my_key: null });
    });

    it("removing a pairing ends it for both sides", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");
        const pid = await pair(a, b);

        expect((await api("DELETE", "/v1/pairings/" + pid, b.key)).status).toBe(200);
        expect((await api("GET", "/v1/pairings", a.key)).data.pairings[0]).toMatchObject({ status: "ended", ended_reason: "removed" });
        expect((await upload(a, b.guid)).status).toBe(403);
    });
});

describe("slots and inbox", () =>
{
    it("delivers a partner's copy and numbers it", async () =>
    {
        const kael = await makeUser("Kaelith Emberfall");
        const bran = await makeUser("Brannoc Ashvale");

        await pair(kael, bran);

        const up = await upload(kael, bran.guid);

        expect(up.status).toBe(201);

        const box = await api("GET", "/v1/inbox?since=0", bran.key);

        expect(box.data.packets).toHaveLength(1);
        expect(box.data.packets[0]).toMatchObject({ from_guid: kael.guid, to_guid: bran.guid, packet: PACKET, kind: "partner", seq: up.data.seq });

        const again = await api("GET", "/v1/inbox?since=" + box.data.next, bran.key);

        expect(again.data.packets).toHaveLength(0);
        // The sender doesn't get its own partner copy back.
        expect((await api("GET", "/v1/inbox?since=0", kael.key)).data.packets).toHaveLength(0);
    });

    it("newest save wins and older ones are refused", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        const first = await upload(a, b.guid, "AAAA", T0 + 100);

        expect((await upload(a, b.guid, "BBBB", T0 + 50)).status).toBe(409);

        const same = await upload(a, b.guid, "AAAA", T0 + 100);

        expect(same.data).toMatchObject({ unchanged: true, seq: first.data.seq });

        const newer = await upload(a, b.guid, "CCCC", T0 + 200);

        expect(newer.data.seq).toBeGreaterThan(first.data.seq);

        const box = await api("GET", "/v1/inbox?since=0", b.key);

        expect(box.data.packets.map((p: any) => p.packet)).toEqual(["CCCC"]);
    });

    it("server numbers always rise across uploaders", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        const s1 = (await upload(a, b.guid, "AAAA", T0)).data.seq;
        const s2 = (await upload(b, a.guid, "BBBB", T0)).data.seq;
        const s3 = (await upload(a, b.guid, "CCCC", T0 + 1)).data.seq;

        expect(s2).toBeGreaterThan(s1);
        expect(s3).toBeGreaterThan(s2);
    });

    it("the self slot reaches your other PC, never your partner", async () =>
    {
        const kael = await makeUser("Kaelith Emberfall");
        const bran = await makeUser("Brannoc Ashvale");

        await pair(kael, bran);

        const link = await api("POST", "/v1/link-codes", kael.key);
        const laptop = newKey();

        expect((await api("POST", "/v1/link-codes/redeem", laptop, { code: link.data.code, label: "KAEL-LAPTOP" })).status).toBe(200);
        expect((await upload(kael, kael.guid, "SELFCOPY")).status).toBe(201);

        const mine = await api("GET", "/v1/inbox?since=0", laptop);

        expect(mine.data.packets).toEqual([expect.objectContaining({ kind: "self", packet: "SELFCOPY" })]);
        expect((await api("GET", "/v1/inbox?since=0", bran.key)).data.packets).toHaveLength(0);
    });

    it("pages large inboxes", async () =>
    {
        const hub = await makeUser("Hub");

        for (let i = 0; i < 10; i++)
        {
            const f = await makeUser("Friend" + String.fromCharCode(97 + i));

            await pair(hub, f);

            for (let j = 0; j < 3; j++) await upload(f, hub.guid, "P" + i + "x" + j, T0 + j);
        }

        const p1 = await api("GET", "/v1/inbox?since=0", hub.key);

        expect(p1.data.packets).toHaveLength(10); // one live slot per partner
        expect(p1.data.more).toBe(false);
    });
});

describe("PCs, recovery and deletion", () =>
{
    it("links a second PC, lists both, removes one", async () =>
    {
        const u = await makeUser("Aaa");
        const link = await api("POST", "/v1/link-codes", u.key);
        const pc2 = newKey();

        await api("POST", "/v1/link-codes/redeem", pc2, { code: link.data.code, label: "Laptop" });

        const me = await api("GET", "/v1/account", pc2);

        expect(me.data.account.id).toBe(u.account);
        expect(me.data.pcs).toHaveLength(2);

        const other = me.data.pcs.find((p: any) => !p.current);

        expect((await api("DELETE", "/v1/keys/" + other.id, pc2)).status).toBe(200);
        expect((await api("GET", "/v1/account", u.key)).status).toBe(401);
    });

    it("link codes are single use", async () =>
    {
        const u = await makeUser("Aaa");
        const link = (await api("POST", "/v1/link-codes", u.key)).data.code;

        expect((await api("POST", "/v1/link-codes/redeem", newKey(), { code: link })).status).toBe(200);
        expect((await api("POST", "/v1/link-codes/redeem", newKey(), { code: link })).status).toBe(404);
    });

    it("a recovery code adds a PC, keeps pairings, and is replaced on use", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);

        const fresh = newKey();
        const r = await api("POST", "/v1/recover", fresh, { code: a.recovery });

        expect(r.status).toBe(200);
        expect(r.data.account_id).toBe(a.account);
        expect(r.data.recovery_code).not.toBe(a.recovery);
        expect((await api("GET", "/v1/pairings", fresh)).data.pairings).toHaveLength(1);
        expect((await api("POST", "/v1/recover", newKey(), { code: a.recovery })).status).toBe(404);
    });

    it("delete my data removes everything and partners see the pairing ended", async () =>
    {
        const a = await makeUser("Aaa");
        const b = await makeUser("Bbb");

        await pair(a, b);
        await upload(a, b.guid);

        expect((await api("DELETE", "/v1/account", a.key)).status).toBe(200);
        expect((await api("GET", "/v1/account", a.key)).status).toBe(401);

        const theirs = await api("GET", "/v1/pairings", b.key);

        expect(theirs.data.pairings[0]).toMatchObject({ status: "ended", ended_reason: "deleted", partner_guid: "", partner_name: "" });
        expect((await api("GET", "/v1/inbox?since=0", b.key)).data.packets).toHaveLength(0);

        const left = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM keys WHERE account_id = ?1) + (SELECT COUNT(*) FROM characters WHERE account_id = ?1) + (SELECT COUNT(*) FROM slots WHERE account_id = ?1) AS n").bind(a.account).first<{ n: number }>();

        expect(left!.n).toBe(0);
    });
});

describe("invite-only mode", () =>
{
    it("needs an invite when sign-ups are closed", async () =>
    {
        const inviter = await makeUser("Aaa");

        await env.DB.prepare("UPDATE settings SET v = 'invite' WHERE k = 'signups'").run();

        try
        {
            expect((await api("POST", "/v1/accounts", newKey(), {})).data.error).toBe("invite_required");

            const inv = await api("POST", "/v1/invites", inviter.key);

            expect(inv.status).toBe(201);

            const k = newKey();

            expect((await api("POST", "/v1/accounts", k, { invite: inv.data.code })).status).toBe(201);
            expect((await api("POST", "/v1/accounts", newKey(), { invite: inv.data.code })).status).toBe(403);
        }

        finally
        {
            await env.DB.prepare("UPDATE settings SET v = 'open' WHERE k = 'signups'").run();
        }
    });
});
