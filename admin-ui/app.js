// Sterling Admin window. Text from the database is only ever set with textContent.
"use strict";

const KEY = location.hash.slice(1);

history.replaceState(null, "", location.pathname); // keep the key out of the address bar

// Shorthand for getElementById.
const $ = (id) => document.getElementById(id);
// Makes an element with a class and text (always text, never HTML).
const el = (tag, cls, text) =>
{
    const element = document.createElement(tag);

    if (cls) element.className = cls;
    if (text != null) element.textContent = text;

    return element;
};

// A number with thousands separators.
const fmt = (value) => Number(value).toLocaleString();

// Calls one of the admin tool's fixed jobs with this window's key.
async function api(job, body)
{
    const response = await fetch("/api/" + job, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": KEY }, body: JSON.stringify(body || {}) });
    const result = await response.json().catch(() => ({ error: "Bad answer from the admin tool." }));

    if (!response.ok) throw new Error(result.error || "Failed.");

    return result;
}

let toastTimer;

// A short message at the bottom of the window.
function toast(text, bad)
{
    const box = $("toast");

    box.textContent = String(text).replace(/^Error: /, "");
    box.className = "toast" + (bad ? " bad" : "");
    box.hidden = false;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), bad ? 7000 : 3000);
}

// Shows an error as a red toast.
const fail = (error) => toast(error.message || error, true);

// Runs a job with its button disabled, and shows any error.
async function busy(btn, work)
{
    if (btn) btn.disabled = true;

    try
    {
        return await work();
    }

    catch (error)
    {
        fail(error);
    }

    finally
    {
        if (btn) btn.disabled = false;
    }
}

// How long ago a Unix time was, in words.
function ago(time)
{
    if (!time) return "never";

    const seconds = Math.max(0, Date.now() / 1000 - time);

    if (seconds < 90) return "just now";

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) return minutes + " min ago";

    const hours = Math.round(minutes / 60);

    if (hours < 48) return hours + (hours === 1 ? " hr ago" : " hrs ago");

    return Math.round(hours / 24) + " days ago";
}

// A Unix time as Today, Yesterday or a date.
function day(time)
{
    if (!time) return "";

    const date = new Date(time * 1000), now = new Date();

    if (date.toDateString() === now.toDateString()) return "Today";

    const yesterday = new Date(now);

    yesterday.setDate(now.getDate() - 1);

    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

    return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Fills a box with label and value rows.
function kv(box, rows)
{
    box.replaceChildren();

    for (const [label, value, cls] of rows)
    {
        const row = el("div");

        row.append(el("span", "", label), el("span", cls || "", value));
        box.append(row);
    }
}

// A dialog with buttons; resolves with the button's value, or null on Escape.
function dialog(title, body, buttons)
{
    return new Promise((resolve) =>
    {
        $("dlg-title").textContent = title;
        $("dlg-body").replaceChildren(...body);

        const row = $("dlg-btns");

        row.replaceChildren();

        const close = (choice) =>
        {
            $("scrim").hidden = true;
            resolve(choice);
        };

        for (const [label, value, cls] of buttons)
        {
            const button = el("button", "btn " + (cls || ""), label);

            button.type = "button";
            button.onclick = () => close(value);
            row.append(button);
        }

        $("scrim").hidden = false;
        $("scrim").onkeydown = (event) =>
        {
            if (event.key === "Escape") close(null);
        };

        row.firstElementChild.focus();
    });
}

// ---------------------------------------------------------------- pages

let page = "overview";

// Opens a page and loads what it shows.
function go(target)
{
    page = target;

    for (const button of document.querySelectorAll(".side > button")) if (button.dataset.page === target) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    for (const section of document.querySelectorAll(".page")) section.hidden = section.id !== "page-" + target;

    if (target === "overview") loadOverview();
    if (target === "accounts") loadAccounts();
    if (target === "signups") loadSignups();
    if (target === "notices") loadNotices();
}

let lastSignups = null;

// The Overview page: server check, warnings, installs, usage and health.
async function loadOverview()
{
    $("ov-loading").hidden = false;

    try
    {
        const overview = await api("overview");

        lastSignups = overview.db.signups;
        $("srv-url").textContent = (overview.server.url || "").replace("https://", "");
        $("sign-in").textContent = overview.sign_in === "token" ? "Using the database-only token" : "Using your Wrangler login";
        $("ov").hidden = false;

        const warnBox = $("warns");

        warnBox.replaceChildren();

        if (!overview.warnings.length) warnBox.append(el("div", "okbox", "All good. Nothing needs your attention."));

        for (const warning of overview.warnings)
        {
            const box = el("div", "warnbox");
            const inner = el("div");

            inner.append(el("div", "t", warning.text), el("div", "small", warning.fix));
            box.append(inner);
            warnBox.append(box);
        }

        $("s-accounts").textContent = fmt(overview.db.accounts);
        $("s-active").textContent = fmt(overview.db.active_today);
        $("s-pairings").textContent = fmt(overview.db.pairings);

        const ins = overview.installs;

        kv($("inst-rows"),
        [
            ["PCs with the app", fmt(ins.pcs)],
            ["Used in the last 7 days", fmt(ins.active_7d), "good"],
            ["Used in the last 30 days", fmt(ins.active_30d)],
            ["New in the last 7 days", fmt(ins.new_7d)],
        ]);

        kv($("inst-vers"), ins.versions.length ? ins.versions.map((entry) => [entry.version, fmt(entry.pcs)]) : [["None yet", ""]]);

        const server = overview.server;

        kv($("server-rows"),
        [
            ["Status", server.ok ? "Online" : "Not answering", server.ok ? "good" : "bad"],
            ["Response time", server.ms != null ? server.ms + " ms" : "-"],
            ["API version", server.api != null ? String(server.api) : "-"],
            ["Oldest app allowed", server.min_app || "-"],
            ["Hourly job last ran", overview.cron.last ? ago(overview.cron.last) : "not recorded yet", overview.cron.last && Date.now() / 1000 - overview.cron.last < 7200 ? "" : "warn-t"],
            ["Daily cleanup last ran", overview.cron.cleanup_last ? ago(overview.cron.cleanup_last) : "not recorded yet"],
            ["Last usage alert email", overview.cron.last_alert || "none"],
            ["Stored copies", fmt(overview.db.slots) + " (" + Math.round(overview.db.packet_bytes / 1024) + " KB)"],
        ]);

        const meters = $("meters");

        meters.replaceChildren();

        for (const row of (overview.usage ? overview.usage.rows : []))
        {
            const meter = el("div", "meter");
            const top = el("div", "row-between");

            top.append(el("span", "", row.name), el("span", row.percent >= 50 ? "warn-t" : "", fmt(row.used) + " of " + fmt(row.limit) + " · " + row.percent.toFixed(0) + "%"));

            const bar = el("div", "bar");
            const fill = el("i", row.percent >= 50 ? "warn" : "");

            fill.style.width = Math.min(100, Math.max(0.8, row.percent)) + "%";
            bar.append(fill);

            meter.append(top, bar);
            meters.append(meter);
        }

        const health = overview.health;

        kv($("health"), health ?
        [
            ["Server errors today", fmt(health.errors) + (health.requests ? " (" + health.error_pct.toFixed(1) + "%)" : ""), health.error_pct >= 5 && health.requests >= 50 ? "warn-t" : ""],
            ["CPU per request, typical", health.cpuP50.toFixed(1) + " ms"],
            ["CPU per request, slowest", health.cpuP99.toFixed(1) + " ms of 10", health.cpuP99 >= 7 ? "warn-t" : ""],
        ] : []);
        $("notes").replaceChildren(...overview.notes.map((note) => el("div", "", note)));

        kv($("signup-rows"),
        [
            ["Sign-up", overview.db.signups === "open" ? "Open" : "Invite only", overview.db.signups === "open" ? "good" : "warn-t"],
            ["New accounts, 24 hours", fmt(overview.db.new_24h), overview.db.new_24h >= 20 ? "warn-t" : ""],
            ["New accounts, 7 days", fmt(overview.db.new_7d)],
            ["Never paired yet", fmt(overview.db.unpaired_new)],
        ]);

        const cleanup = overview.cleanup_preview;

        kv($("cleanup-rows"),
        [
            ["Unpaired accounts over 7 days", fmt(cleanup.unpaired_accounts)],
            ["Accounts idle 12 months", fmt(cleanup.idle_accounts)],
            ["Copies untouched 30 days", fmt(cleanup.old_copies)],
            ["Ended pairings over 30 days", fmt(cleanup.old_pairings)],
            ["Expired codes", fmt(cleanup.expired_codes)],
        ]);
    }

    catch (error)
    {
        fail(error);
    }

    $("ov-loading").hidden = true;
}

// The Accounts page, with ban and unban buttons.
async function loadAccounts()
{
    const body = $("ac-rows");

    try
    {
        const rows = await api("accounts");

        body.replaceChildren();

        if (!rows.length)
        {
            const row = el("tr");
            const cell = el("td", "muted", "No accounts yet.");

            cell.colSpan = 6;
            row.append(cell);
            body.append(row);
        }

        for (const account of rows)
        {
            const row = el("tr");

            row.append(el("td", account.characters ? "" : "muted", account.characters || "(no characters yet)"), el("td", "mono", account.account), el("td", "", String(account.pairings)), el("td", "", String(account.pcs)), el("td", "", day(account.last_seen)));

            const act = el("td");

            if (account.banned)
            {
                act.append(el("span", "bad", "Banned "));

                const button = el("button", "btn", "Unban");

                button.type = "button";

                button.onclick = async () =>
                {
                    const ok = await dialog("Unban this account?", [el("div", "small muted mono", account.account), el("p", "", "It can sign in again. Its old pairings stay ended; friends pair again with new codes.")], [["Cancel", false, "ghost"], ["Unban", true, ""]]);

                    if (ok) busy(button, async () =>
                    {
                        toast((await api("unban", { id: account.account })).message);
                        loadAccounts();
                    });
                };

                act.append(button);
            }

            else
            {
                const button = el("button", "btn bad", "Ban...");

                button.type = "button";

                button.onclick = async () =>
                {
                    const who = el("div", "small muted");

                    who.append("Account ", el("span", "mono", account.account), account.characters ? " (" + account.characters + ")" : "");

                    const ok = await dialog("Ban this account?", [who, el("p", "", "Its pairings end, its stored copies and codes are deleted, and it can no longer sign in. You can unban later, but pairings stay ended.")], [["Cancel", false, "ghost"], ["Ban account", true, "bad"]]);

                    if (ok) busy(button, async () =>
                    {
                        toast((await api("ban", { id: account.account })).message);
                        loadAccounts();
                    });
                };

                act.append(button);
            }

            row.append(act);
            body.append(row);
        }
    }

    catch (error)
    {
        fail(error);
    }
}

// Shows whether sign-ups are open or invite only.
async function loadSignups()
{
    if (lastSignups === null) { try
    {
        lastSignups = (await api("overview")).db.signups;
    }

    catch (error)
    {
        return fail(error);
    }
    }

    const open = lastSignups === "open";

    $("su-pill").textContent = open ? "ON" : "OFF";
    $("su-pill").className = "pill " + (open ? "on" : "off");
    $("su-toggle").textContent = open ? "Close sign-ups" : "Open sign-ups";
    $("su-toggle").disabled = false;
}

$("su-toggle").onclick = async () =>
{
    const open = lastSignups === "open";
    const ok = await dialog(open ? "Close sign-ups?" : "Open sign-ups?", [el("p", "", open ? "New accounts will need an invite from an existing user. Everyone already signed up keeps syncing." : "Anyone with the app can make an account again.")], [["Cancel", false, "ghost"], [open ? "Close sign-ups" : "Open sign-ups", true, "primary"]]);

    if (!ok) return;

    busy($("su-toggle"), async () =>
    {
        toast((await api("signups", { mode: open ? "off" : "on" })).message);
        lastSignups = open ? "invite" : "open";
        loadSignups();
    });
};

$("ov-refresh").onclick = () => busy($("ov-refresh"), loadOverview);
$("ac-refresh").onclick = () => busy($("ac-refresh"), loadAccounts);
$("backup").onclick = () => busy($("backup"), async () =>
{
    $("backup").textContent = "Backing up...";

    try
    {
        toast((await api("backup")).message);
    }

    finally
    {
        $("backup").textContent = "Back up now";
    }
});

$("open-backups").onclick = () => api("openbackups").catch(fail);

for (const button of document.querySelectorAll("[data-page]")) button.addEventListener("click", () => go(button.dataset.page));

// ---------------------------------------------------------------- notices

const LEVEL_NAME = { info: "Gold: news", warn: "Amber: heads-up", bad: "Red: action needed" };

// Which app versions a notice is for, in words.
function versionsText(notice)
{
    if (notice.from && notice.to) return notice.from === notice.to ? "App " + notice.from : "Apps " + notice.from + " to " + notice.to;
    if (notice.to) return "Apps " + notice.to + " and older";
    if (notice.from) return "Apps " + notice.from + " and newer";

    return "Every app version";
}

// A notice as the app shows it, with its details when asked.
function noticeBox(notice, withMeta)
{
    const box = el("div", "notice " + notice.level);
    const left = el("div");

    left.append(el("div", "t", notice.text));

    if (withMeta)
    {
        const bits = [LEVEL_NAME[notice.level], versionsText(notice)];

        if (notice.link) bits.push("Button: " + notice.link.replace("https://", ""));

        bits.push(notice.until ? "Ends " + new Date(notice.until * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Stays until removed");
        left.append(el("div", "meta", bits.join(" · ")));
    }

    box.append(left);

    return box;
}

// The Notices page: the live notices and the form to add one.
async function loadNotices()
{
    const list = $("no-list");

    try
    {
        const rows = await api("notices");

        list.replaceChildren();

        const now = Date.now() / 1000;
        const live = rows.filter((notice) => !notice.until || notice.until > now);

        if (!live.length) list.append(el("div", "muted", "No notices. Apps show nothing extra."));

        for (const notice of live)
        {
            const box = noticeBox(notice, true);
            const button = el("button", "btn bad", "Remove");

            button.type = "button";

            button.onclick = async () =>
            {
                const ok = await dialog("Remove this notice?", [noticeBox(notice, false), el("p", "", "Apps stop showing it at their next check.")], [["Cancel", false, "ghost"], ["Remove", true, "bad"]]);

                if (ok) busy(button, async () =>
                {
                    toast((await api("removenotice", { id: notice.id })).message);
                    loadNotices();
                });
            };

            box.append(button);
            list.append(box);
        }
    }

    catch (error)
    {
        fail(error);
    }
}

// Shows the new notice as the app will show it while it's typed.
function previewNotice()
{
    const text = $("no-text").value.replace(/\s+/g, " ").trim();

    $("no-count").textContent = $("no-text").value.length + " / 240";

    const placeholder = $("no-preview");

    placeholder.className = "notice " + $("no-level").value;
    placeholder.replaceChildren(noticeBox({ text: text || "Your message shows here.", level: $("no-level").value }, false).firstChild);

    if ($("no-link").value.trim())
    {
        const button = el("span", "btn", "Open");

        placeholder.append(button);
    }
}

for (const id of ["no-text", "no-level", "no-link"]) $(id).addEventListener("input", previewNotice);

$("no-post").onclick = async () =>
{
    const fields =
    {
        text: $("no-text").value, level: $("no-level").value, from: $("no-from").value.trim(), to: $("no-to").value.trim(),
        link: $("no-link").value.trim(), days: Number($("no-days").value),
    };

    const notice = { ...fields, text: fields.text.replace(/\s+/g, " ").trim(), until: fields.days ? Math.floor(Date.now() / 1000) + fields.days * 86400 : undefined };

    if (!notice.text) return toast("Write a message first.", true);

    const ok = await dialog("Post this notice?", [noticeBox(notice, true), el("p", "", "Every Companion app in that version range shows it on its Home page.")], [["Cancel", false, "ghost"], ["Post notice", true, "primary"]]);

    if (!ok) return;

    busy($("no-post"), async () =>
    {
        toast((await api("addnotice", fields)).message);
        $("no-text").value = "";
        $("no-link").value = "";
        previewNotice();
        loadNotices();
    });
};

$("no-refresh").onclick = () => busy($("no-refresh"), loadNotices);
previewNotice();

// Tell the tool the window is still open, so it can stop on its own after the window closes.
setInterval(() => api("ping").catch(() => {}), 15000);
go("overview");
