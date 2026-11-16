// Security audit, Nov 15 2026. Each finding from the audit is kept here as a test.
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { api, env, makeUser, pair, upload, newKey, BASE, PACKET, T0 } from "./helpers";
import { cleanup } from "../src/cron";
import { MAX_UPLOADS_PER_DAY, DAY } from "../src/util";

const nowS = () => Math.floor(Date.now() / 1000);

describe("using up the server for everyone", () => {
  it("one account can't upload without end: there is a daily cap", async () => {
    const a = await makeUser("Capper");
    // Pretend this account already used its allowance today.
    const day = Math.floor(nowS() / DAY);
    await env.DB.prepare("INSERT INTO counters (k, v) VALUES (?1, ?2)").bind(`up:${day}:${a.account}`, MAX_UPLOADS_PER_DAY).run();
    const r = await upload(a, a.guid);
    expect(r.status).toBe(429);
    expect(r.data.error).toBe("daily_limit");
    // Another account is not affected.
    const b = await makeUser("Other");
    expect((await upload(b, b.guid)).status).toBe(201);
  });

  it("counts each saved upload, and not refused ones", async () => {
    const a = await makeUser("Counter");
    const day = Math.floor(nowS() / DAY);
    const used = async () =>
      (await env.DB.prepare("SELECT v FROM counters WHERE k = ?1").bind(`up:${day}:${a.account}`).first<{ v: number }>())?.v ?? 0;
    await upload(a, a.guid, PACKET, T0);
    expect(await used()).toBe(1);
    await upload(a, a.guid, PACKET, T0);            // unchanged: nothing written
    await upload(a, a.guid, "OLDER", T0 - 100);     // stale: nothing written
    expect(await used()).toBe(1);
  });

  it("cleanup drops old daily counters and keeps today's", async () => {
    const day = Math.floor(nowS() / DAY);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO counters (k, v) VALUES (?1, 5)").bind(`up:${day - 3}:aaaaaaaaaaaaaaaa`),
      env.DB.prepare("INSERT INTO counters (k, v) VALUES (?1, 5)").bind(`up:${day}:bbbbbbbbbbbbbbbb`),
    ]);
    await cleanup(env);
    const left = await env.DB.prepare("SELECT k FROM counters WHERE k LIKE 'up:%'").all<{ k: string }>();
    const keys = left.results.map((r) => r.k);
    expect(keys).not.toContain(`up:${day - 3}:aaaaaaaaaaaaaaaa`);
    expect(keys).toContain(`up:${day}:bbbbbbbbbbbbbbbb`);
    const seq = await env.DB.prepare("SELECT v FROM counters WHERE k = 'seq'").first();
    expect(seq).not.toBeNull();
  });

  it("a body with no length header is still cut off at the cap", async () => {
    const a = await makeUser("Streamer");
    const big = "A".repeat(300 * 1024);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"packet":"'));
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode(big));
        c.enqueue(new TextEncoder().encode('","game_time":' + T0 + ',"proto":6}'));
        c.close();
      },
    });
    const res = await SELF.fetch(`${BASE}/v1/slots/${a.guid}/${a.guid}`, {
      method: "PUT",
      headers: { authorization: "Bearer " + a.key, "content-type": "application/json" },
      body: stream,
      // @ts-expect-error needed for streamed request bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
});

describe("locking a slot with a made-up date", () => {
  it("refuses a save stamped more than a day in the future", async () => {
    const a = await makeUser("Timelord");
    const far = await upload(a, a.guid, PACKET, nowS() + 30 * DAY);
    expect(far.status).toBe(400);
    expect(far.data.error).toBe("bad_game_time");
    // A real save still works afterwards, and a little clock drift is fine.
    expect((await upload(a, a.guid, PACKET, nowS() + 60)).status).toBe(201);
  });
});

describe("codes are single use even in a race", () => {
  it("two accounts redeeming one pairing code at once: only one pairs", async () => {
    const owner = await makeUser("Owner");
    const x = await makeUser("Racer One");
    const y = await makeUser("Racer Two");
    const code = (await api("POST", "/v1/pair-codes", owner.key, { guid: owner.guid })).data.code;
    const [r1, r2] = await Promise.all([
      api("POST", "/v1/pair-codes/redeem", x.key, { code, guid: x.guid }),
      api("POST", "/v1/pair-codes/redeem", y.key, { code, guid: y.guid }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 404]);
    const live = (await api("GET", "/v1/pairings", owner.key)).data.pairings.filter((p: any) => p.status === "active");
    expect(live.length).toBe(1);
  });

  it("two PCs redeeming one link code at once: only one is added", async () => {
    const a = await makeUser("Linker");
    const code = (await api("POST", "/v1/link-codes", a.key)).data.code;
    const [r1, r2] = await Promise.all([
      api("POST", "/v1/link-codes/redeem", newKey(), { code, label: "One" }),
      api("POST", "/v1/link-codes/redeem", newKey(), { code, label: "Two" }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 404]);
    expect((await api("GET", "/v1/account", a.key)).data.pcs.length).toBe(2);
  });

  it("two sign-ups with one invite at once: only one account is made", async () => {
    const host = await makeUser("Host");
    await env.DB.prepare("UPDATE settings SET v = 'invite' WHERE k = 'signups'").run();
    try {
      const invite = (await api("POST", "/v1/invites", host.key)).data.code;
      const [r1, r2] = await Promise.all([
        api("POST", "/v1/accounts", newKey(), { label: "One", invite }),
        api("POST", "/v1/accounts", newKey(), { label: "Two", invite }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 403]);
    } finally {
      await env.DB.prepare("UPDATE settings SET v = 'open' WHERE k = 'signups'").run();
    }
  });
});

describe("junk in the address", () => {
  it("a broken percent-escape is bad input, not a server error", async () => {
    const a = await makeUser("Percent");
    for (const path of ["/v1/characters/%E0%A4%A", "/v1/slots/%ZZ/%ZZ", "/v1/characters/%"]) {
      const r = await api("PUT", path, a.key, { name: "X", realm: "Y", packet: PACKET, game_time: T0, proto: 6 });
      expect(r.status).toBe(400);
      expect(r.data.error).toBe("bad_path");
    }
  });
});

describe("pretending to be a friend's character", () => {
  it("a stranger listing a paired character's GUID is flagged as a different install and replaces nothing unless asked", async () => {
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    await pair(alice, bob);
    await upload(bob, alice.guid, "BOBSREALCOPY", T0);
    // Mallory lists Bob's GUID under her own account and makes a code for it.
    const mal = await makeUser("Mallory");
    await api("PUT", "/v1/characters/" + bob.guid, mal.key, { name: "Bob", realm: "CAMWOW US2 Realm 2 PvP" });
    const code = (await api("POST", "/v1/pair-codes", mal.key, { guid: bob.guid })).data.code;
    // What the app checks before pairing on its own: same GUID, but a different install.
    const peek = await api("POST", "/v1/pair-codes/peek", alice.key, { code, guid: alice.guid });
    expect(peek.data.partner.guid).toBe(bob.guid);
    expect(peek.data.different_install).toBe(true);
    // Without "replace" nothing changes, and the real Bob's copy is still the one Alice gets.
    const r = await api("POST", "/v1/pair-codes/redeem", alice.key, { code, guid: alice.guid });
    expect(r.status).toBe(409);
    const inbox = (await api("GET", "/v1/inbox?since=0", alice.key)).data.packets;
    expect(inbox.map((p: any) => p.packet)).toContain("BOBSREALCOPY");
    // Mallory never sees anything of Alice's.
    expect((await api("GET", "/v1/inbox?since=0", mal.key)).data.packets.length).toBe(0);
  });
});
