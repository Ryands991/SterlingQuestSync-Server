import { describe, it, expect, afterEach } from "vitest";
import { api, env, makeUser } from "./helpers";
import { parseNotices, checkNotice, activeNotices, MAX_NOTICES } from "../src/notices";

async function store(v: unknown) {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('notices', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(text).run();
}

const now = () => Math.floor(Date.now() / 1000);
const ok = { id: "manual-0123", text: "Manual update needed: download 0.1.24 from the app's page.", level: "bad", to: "0.1.23", link: "https://github.com/SterlingAddons/SterlingQuestSync-App/releases/latest" };

describe("notices in meta", () => {
  afterEach(async () => { await env.DB.prepare("DELETE FROM settings WHERE k = 'notices'").run(); });

  it("has an empty list when none are set", async () => {
    const r = await api("GET", "/v1/meta");
    expect(r.status).toBe(200);
    expect(r.data.notices).toEqual([]);
    expect(r.data.signups).toBe("open");
  });

  it("serves a stored notice as is", async () => {
    await store([ok]);
    const r = await api("GET", "/v1/meta");
    expect(r.data.notices).toEqual([ok]);
  });

  it("drops expired ones and keeps current ones", async () => {
    await store([{ ...ok, id: "old", until: now() - 10 }, { ...ok, id: "new", until: now() + 3600 }]);
    const r = await api("GET", "/v1/meta");
    expect(r.data.notices.map((n: any) => n.id)).toEqual(["new"]);
  });

  it("never serves a broken list", async () => {
    await store("not json");
    expect((await api("GET", "/v1/meta")).data.notices).toEqual([]);
    await store({ id: "x" });
    expect((await api("GET", "/v1/meta")).data.notices).toEqual([]);
  });

  it("drops bad entries, keeps good ones", async () => {
    await store([
      { ...ok, id: "elsewhere", link: "https://evil.example/download" },
      { ...ok, id: "lookalike", link: "https://github.com/SterlingAddonsX/app" },
      { ...ok, id: "markup", text: "<script>alert(1)</script>" },
      { ...ok, id: "BAD ID" },
      { ...ok, id: "backwards", from: "0.2.0", to: "0.1.0" },
      { ...ok, id: "level", level: "urgent" },
      { ...ok, id: "long", text: "x".repeat(241) },
      ok,
      { ...ok, text: "a repeat of the same id" },
    ]);
    const r = await api("GET", "/v1/meta");
    expect(r.data.notices).toEqual([ok]);
  });
});

describe("notice rules", () => {
  it("keeps at most five", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...ok, id: "n" + i }));
    expect(parseNotices(JSON.stringify(many))).toHaveLength(MAX_NOTICES);
  });

  it("allows only Sterling's own pages as links", () => {
    for (const link of [
      "https://github.com/SterlingAddons/SterlingQuestSync-App/releases/latest",
      "https://sterlingaddons.com/help",
    ]) expect(checkNotice({ ...ok, link })).not.toBeNull();
    for (const link of [
      "http://github.com/SterlingAddons/x",
      "https://github.com/SterlingAddons.evil.example/x",
      "https://sterlingaddons.com.evil.example/",
      "https://github.com/Someone/x",
      "javascript:alert(1)",
      "https://github.com/SterlingAddons/x y",
    ]) expect(checkNotice({ ...ok, link })).toBeNull();
  });

  it("tidies spacing and accepts notices without versions or links", () => {
    const n = checkNotice({ id: "maint", text: "  Server   maintenance tonight. ", level: "info" });
    expect(n).toEqual({ id: "maint", text: "Server maintenance tonight.", level: "info" });
  });

  it("needs whole version numbers", () => {
    expect(checkNotice({ ...ok, to: "0.1" })).toBeNull();
    expect(checkNotice({ ...ok, from: "v0.1.0" })).toBeNull();
    expect(activeNotices(JSON.stringify([{ ...ok, from: "0.1.0", to: "0.1.23" }]), 1)).toHaveLength(1);
  });
});

describe("app versions per PC", () => {
  const ver = async (key: string) =>
    (await env.DB.prepare("SELECT app_version AS v FROM keys WHERE hash = ?1").bind(await sha(key)).first<{ v: string | null }>())?.v ?? null;
  async function sha(s: string) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("keeps the version from the app's User-Agent, and only a real one", async () => {
    const u = await makeUser("Tovak Stoneroot");
    expect(await ver(u.key)).toBeNull();
    await api("GET", "/v1/account", u.key, undefined, { "user-agent": "SterlingQuestSync/0.1.25" });
    expect(await ver(u.key)).toBe("0.1.25");
    await api("GET", "/v1/account", u.key, undefined, { "user-agent": "Mozilla/5.0 <script>" });
    expect(await ver(u.key)).toBe("0.1.25");
    await api("GET", "/v1/account", u.key, undefined, { "user-agent": "SterlingQuestSync/0.1.26" });
    expect(await ver(u.key)).toBe("0.1.26");
  });
});

describe("update feed", () => {
  it("sends the app to the newest latest.json", async () => {
    const { SELF } = await import("cloudflare:test");
    const r = await SELF.fetch("https://sync.test/update/latest.json", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://github.com/SterlingAddons/SterlingQuestSync-App/releases/latest/download/latest.json");
    expect((await SELF.fetch("https://sync.test/update/other.json", { redirect: "manual" })).status).toBe(404);
  });
});
