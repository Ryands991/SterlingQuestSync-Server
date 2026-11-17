// Sterling Admin window. Text from the database is only ever set with textContent.
"use strict";

const KEY = location.hash.slice(1);
history.replaceState(null, "", location.pathname); // keep the key out of the address bar
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (n) => Number(n).toLocaleString();

async function api(job, body) {
  const r = await fetch("/api/" + job, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": KEY }, body: JSON.stringify(body || {}) });
  const v = await r.json().catch(() => ({ error: "Bad answer from the admin tool." }));
  if (!r.ok) throw new Error(v.error || "Failed.");
  return v;
}

let toastTimer;
function toast(text, bad) {
  const t = $("toast"); t.textContent = String(text).replace(/^Error: /, ""); t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), bad ? 7000 : 3000);
}
const fail = (e) => toast(e.message || e, true);
async function busy(btn, fn) { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; } }

function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 90) return "just now";
  const m = Math.round(s / 60); if (m < 60) return m + " min ago";
  const h = Math.round(m / 60); if (h < 48) return h + (h === 1 ? " hr ago" : " hrs ago");
  return Math.round(h / 24) + " days ago";
}
function day(t) {
  if (!t) return "";
  const d = new Date(t * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function kv(box, rows) {
  box.replaceChildren();
  for (const [k, v, cls] of rows) { const d = el("div"); d.append(el("span", "", k), el("span", cls || "", v)); box.append(d); }
}

function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    $("dlg-title").textContent = title;
    $("dlg-body").replaceChildren(...body);
    const row = $("dlg-btns"); row.replaceChildren();
    const close = (v) => { $("scrim").hidden = true; resolve(v); };
    for (const [label, value, cls] of buttons) { const b = el("button", "btn " + (cls || ""), label); b.type = "button"; b.onclick = () => close(value); row.append(b); }
    $("scrim").hidden = false;
    $("scrim").onkeydown = (e) => { if (e.key === "Escape") close(null); };
    row.firstElementChild.focus();
  });
}

// ---------------------------------------------------------------- pages

let page = "overview";
function go(p) {
  page = p;
  for (const b of document.querySelectorAll(".side > button")) if (b.dataset.page === p) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  for (const m of document.querySelectorAll(".page")) m.hidden = m.id !== "page-" + p;
  if (p === "overview") loadOverview();
  if (p === "accounts") loadAccounts();
  if (p === "signups") loadSignups();
  if (p === "notices") loadNotices();
}

let lastSignups = null;
async function loadOverview() {
  $("ov-loading").hidden = false;
  try {
    const o = await api("overview");
    lastSignups = o.db.signups;
    $("srv-url").textContent = (o.server.url || "").replace("https://", "");
    $("sign-in").textContent = o.sign_in === "token" ? "Using the database-only token" : "Using your Wrangler login";
    $("ov").hidden = false;

    const w = $("warns"); w.replaceChildren();
    if (!o.warnings.length) w.append(el("div", "okbox", "All good. Nothing needs your attention."));
    for (const x of o.warnings) {
      const b = el("div", "warnbox"); const inner = el("div");
      inner.append(el("div", "t", x.text), el("div", "small", x.fix)); b.append(inner); w.append(b);
    }

    $("s-accounts").textContent = fmt(o.db.accounts);
    $("s-active").textContent = fmt(o.db.active_today);
    $("s-pairings").textContent = fmt(o.db.pairings);

    const ins = o.installs;
    kv($("inst-rows"), [
      ["PCs with the app", fmt(ins.pcs)],
      ["Used in the last 7 days", fmt(ins.active_7d), "good"],
      ["Used in the last 30 days", fmt(ins.active_30d)],
      ["New in the last 7 days", fmt(ins.new_7d)],
    ]);
    kv($("inst-vers"), ins.versions.length ? ins.versions.map((v) => [v.version, fmt(v.pcs)]) : [["None yet", ""]]);
    const s = o.server;
    kv($("server-rows"), [
      ["Status", s.ok ? "Online" : "Not answering", s.ok ? "good" : "bad"],
      ["Response time", s.ms != null ? s.ms + " ms" : "-"],
      ["API version", s.api != null ? String(s.api) : "-"],
      ["Oldest app allowed", s.min_app || "-"],
      ["Hourly job last ran", o.cron.last ? ago(o.cron.last) : "not recorded yet", o.cron.last && Date.now() / 1000 - o.cron.last < 7200 ? "" : "warn-t"],
      ["Daily cleanup last ran", o.cron.cleanup_last ? ago(o.cron.cleanup_last) : "not recorded yet"],
      ["Last usage alert email", o.cron.last_alert || "none"],
      ["Stored copies", fmt(o.db.slots) + " (" + Math.round(o.db.packet_bytes / 1024) + " KB)"],
    ]);

    const m = $("meters"); m.replaceChildren();
    for (const r of (o.usage ? o.usage.rows : [])) {
      const d = el("div", "meter"); const top = el("div", "row-between");
      top.append(el("span", "", r.name), el("span", r.percent >= 50 ? "warn-t" : "", fmt(r.used) + " of " + fmt(r.limit) + " · " + r.percent.toFixed(0) + "%"));
      const bar = el("div", "bar"); const i = el("i", r.percent >= 50 ? "warn" : ""); i.style.width = Math.min(100, Math.max(0.8, r.percent)) + "%"; bar.append(i);
      d.append(top, bar); m.append(d);
    }
    const h = o.health;
    kv($("health"), h ? [
      ["Server errors today", fmt(h.errors) + (h.requests ? " (" + h.error_pct.toFixed(1) + "%)" : ""), h.error_pct >= 5 && h.requests >= 50 ? "warn-t" : ""],
      ["CPU per request, typical", h.cpuP50.toFixed(1) + " ms"],
      ["CPU per request, slowest", h.cpuP99.toFixed(1) + " ms of 10", h.cpuP99 >= 7 ? "warn-t" : ""],
    ] : []);
    $("notes").replaceChildren(...o.notes.map((n) => el("div", "", n)));

    kv($("signup-rows"), [
      ["Sign-up", o.db.signups === "open" ? "Open" : "Invite only", o.db.signups === "open" ? "good" : "warn-t"],
      ["New accounts, 24 hours", fmt(o.db.new_24h), o.db.new_24h >= 20 ? "warn-t" : ""],
      ["New accounts, 7 days", fmt(o.db.new_7d)],
      ["Never paired yet", fmt(o.db.unpaired_new)],
    ]);
    const c = o.cleanup_preview;
    kv($("cleanup-rows"), [
      ["Unpaired accounts over 7 days", fmt(c.unpaired_accounts)],
      ["Accounts idle 12 months", fmt(c.idle_accounts)],
      ["Copies untouched 30 days", fmt(c.old_copies)],
      ["Ended pairings over 30 days", fmt(c.old_pairings)],
      ["Expired codes", fmt(c.expired_codes)],
    ]);
  } catch (e) { fail(e); }
  $("ov-loading").hidden = true;
}

async function loadAccounts() {
  const body = $("ac-rows");
  try {
    const rows = await api("accounts");
    body.replaceChildren();
    if (!rows.length) { const tr = el("tr"); const td = el("td", "muted", "No accounts yet."); td.colSpan = 6; tr.append(td); body.append(tr); }
    for (const r of rows) {
      const tr = el("tr");
      tr.append(el("td", r.characters ? "" : "muted", r.characters || "(no characters yet)"), el("td", "mono", r.account), el("td", "", String(r.pairings)), el("td", "", String(r.pcs)), el("td", "", day(r.last_seen)));
      const act = el("td");
      if (r.banned) {
        act.append(el("span", "bad", "Banned "));
        const b = el("button", "btn", "Unban"); b.type = "button";
        b.onclick = async () => {
          const ok = await dialog("Unban this account?", [el("div", "small muted mono", r.account), el("p", "", "It can sign in again. Its old pairings stay ended; friends pair again with new codes.")], [["Cancel", false, "ghost"], ["Unban", true, ""]]);
          if (ok) busy(b, async () => { toast((await api("unban", { id: r.account })).message); loadAccounts(); });
        };
        act.append(b);
      } else {
        const b = el("button", "btn bad", "Ban..."); b.type = "button";
        b.onclick = async () => {
          const who = el("div", "small muted"); who.append("Account ", el("span", "mono", r.account), r.characters ? " (" + r.characters + ")" : "");
          const ok = await dialog("Ban this account?", [who, el("p", "", "Its pairings end, its stored copies and codes are deleted, and it can no longer sign in. You can unban later, but pairings stay ended.")], [["Cancel", false, "ghost"], ["Ban account", true, "bad"]]);
          if (ok) busy(b, async () => { toast((await api("ban", { id: r.account })).message); loadAccounts(); });
        };
        act.append(b);
      }
      tr.append(act); body.append(tr);
    }
  } catch (e) { fail(e); }
}

async function loadSignups() {
  if (lastSignups === null) { try { lastSignups = (await api("overview")).db.signups; } catch (e) { return fail(e); } }
  const open = lastSignups === "open";
  $("su-pill").textContent = open ? "ON" : "OFF";
  $("su-pill").className = "pill " + (open ? "on" : "off");
  $("su-toggle").textContent = open ? "Close sign-ups" : "Open sign-ups";
  $("su-toggle").disabled = false;
}

$("su-toggle").onclick = async () => {
  const open = lastSignups === "open";
  const ok = await dialog(open ? "Close sign-ups?" : "Open sign-ups?", [el("p", "", open ? "New accounts will need an invite from an existing user. Everyone already signed up keeps syncing." : "Anyone with the app can make an account again.")], [["Cancel", false, "ghost"], [open ? "Close sign-ups" : "Open sign-ups", true, "primary"]]);
  if (!ok) return;
  busy($("su-toggle"), async () => { toast((await api("signups", { mode: open ? "off" : "on" })).message); lastSignups = open ? "invite" : "open"; loadSignups(); });
};
$("ov-refresh").onclick = () => busy($("ov-refresh"), loadOverview);
$("ac-refresh").onclick = () => busy($("ac-refresh"), loadAccounts);
$("backup").onclick = () => busy($("backup"), async () => { $("backup").textContent = "Backing up..."; try { toast((await api("backup")).message); } finally { $("backup").textContent = "Back up now"; } });
$("open-backups").onclick = () => api("openbackups").catch(fail);
for (const b of document.querySelectorAll("[data-page]")) b.addEventListener("click", () => go(b.dataset.page));

// ---------------------------------------------------------------- notices

const LEVEL_NAME = { info: "Gold: news", warn: "Amber: heads-up", bad: "Red: action needed" };
function versionsText(n) {
  if (n.from && n.to) return n.from === n.to ? "App " + n.from : "Apps " + n.from + " to " + n.to;
  if (n.to) return "Apps " + n.to + " and older";
  if (n.from) return "Apps " + n.from + " and newer";
  return "Every app version";
}
function noticeBox(n, withMeta) {
  const box = el("div", "notice " + n.level);
  const left = el("div");
  left.append(el("div", "t", n.text));
  if (withMeta) {
    const bits = [LEVEL_NAME[n.level], versionsText(n)];
    if (n.link) bits.push("Button: " + n.link.replace("https://", ""));
    bits.push(n.until ? "Ends " + new Date(n.until * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Stays until removed");
    left.append(el("div", "meta", bits.join(" · ")));
  }
  box.append(left);
  return box;
}

async function loadNotices() {
  const list = $("no-list");
  try {
    const rows = await api("notices");
    list.replaceChildren();
    const now = Date.now() / 1000;
    const live = rows.filter((n) => !n.until || n.until > now);
    if (!live.length) list.append(el("div", "muted", "No notices. Apps show nothing extra."));
    for (const n of live) {
      const box = noticeBox(n, true);
      const b = el("button", "btn bad", "Remove"); b.type = "button";
      b.onclick = async () => {
        const ok = await dialog("Remove this notice?", [noticeBox(n, false), el("p", "", "Apps stop showing it at their next check.")], [["Cancel", false, "ghost"], ["Remove", true, "bad"]]);
        if (ok) busy(b, async () => { toast((await api("removenotice", { id: n.id })).message); loadNotices(); });
      };
      box.append(b); list.append(box);
    }
  } catch (e) { fail(e); }
}

function previewNotice() {
  const text = $("no-text").value.replace(/\s+/g, " ").trim();
  $("no-count").textContent = $("no-text").value.length + " / 240";
  const p = $("no-preview");
  p.className = "notice " + $("no-level").value;
  p.replaceChildren(noticeBox({ text: text || "Your message shows here.", level: $("no-level").value }, false).firstChild);
  if ($("no-link").value.trim()) { const b = el("span", "btn", "Open"); p.append(b); }
}
for (const id of ["no-text", "no-level", "no-link"]) $(id).addEventListener("input", previewNotice);

$("no-post").onclick = async () => {
  const fields = {
    text: $("no-text").value, level: $("no-level").value, from: $("no-from").value.trim(), to: $("no-to").value.trim(),
    link: $("no-link").value.trim(), days: Number($("no-days").value),
  };
  const n = { ...fields, text: fields.text.replace(/\s+/g, " ").trim(), until: fields.days ? Math.floor(Date.now() / 1000) + fields.days * 86400 : undefined };
  if (!n.text) return toast("Write a message first.", true);
  const ok = await dialog("Post this notice?", [noticeBox(n, true), el("p", "", "Every Companion app in that version range shows it on its Home page.")], [["Cancel", false, "ghost"], ["Post notice", true, "primary"]]);
  if (!ok) return;
  busy($("no-post"), async () => {
    toast((await api("addnotice", fields)).message);
    $("no-text").value = ""; $("no-link").value = ""; previewNotice();
    loadNotices();
  });
};
$("no-refresh").onclick = () => busy($("no-refresh"), loadNotices);
previewNotice();

// Tell the tool the window is still open, so it can stop on its own after the window closes.
setInterval(() => api("ping").catch(() => {}), 15000);
go("overview");
