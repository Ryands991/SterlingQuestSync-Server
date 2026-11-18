// One hourly Cron Trigger: usage check every hour, cleanup once a day.

import type { Env } from "./index";
import { DAY, now } from "./util";
import { fetchUsage, percentages, FREE_LIMITS } from "./usage";

const CLEANUP_HOUR_UTC = 10; // about 2-3 AM Pacific

// Daily tidy-up: drops expired codes, old slots and long-idle accounts.
export async function cleanup(env: Env, currentTime = now()): Promise<void>
{
    // Accounts idle about 12 months: end their pairings like a deletion, then remove them.
    const stale = await env.DB.prepare("SELECT id FROM accounts WHERE last_seen < ?1 LIMIT 200").bind(currentTime - 365 * DAY).all<{ id: string }>();

    for (const { id } of stale.results)
    {
        await env.DB.batch
        ([
            env.DB.prepare
            (
                "UPDATE pairings SET ended_at = COALESCE(ended_at, ?2), ended_reason = COALESCE(ended_reason, 'expired'), " +
                    "a_account = '', a_guid = '', a_name = '', a_realm = '', a_key = '' WHERE a_account = ?1",
            ).bind(id, currentTime),
            env.DB.prepare
            (
                "UPDATE pairings SET ended_at = COALESCE(ended_at, ?2), ended_reason = COALESCE(ended_reason, 'expired'), " +
                    "b_account = '', b_guid = '', b_name = '', b_realm = '', b_key = '' WHERE b_account = ?1",
            ).bind(id, currentTime),
            env.DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(id),
        ]);
    }

    await env.DB.batch
    ([
        // Accounts that never paired: 7 days.
        env.DB.prepare("DELETE FROM accounts WHERE ever_paired = 0 AND created_at < ?1").bind(currentTime - 7 * DAY),
        // Quest data idle about 30 days.
        env.DB.prepare("DELETE FROM slots WHERE updated_at < ?1").bind(currentTime - 30 * DAY),
        // Ended pairings are kept 30 days so the other side can show "missing key, resync".
        env.DB.prepare("DELETE FROM pairings WHERE ended_at IS NOT NULL AND ended_at < ?1").bind(currentTime - 30 * DAY),
        env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?1").bind(currentTime),
        env.DB.prepare("DELETE FROM link_codes WHERE expires_at < ?1").bind(currentTime),
        env.DB.prepare("DELETE FROM invites WHERE expires_at < ?1").bind(currentTime),
        // Daily upload counters from before yesterday (keys are "up:<day>:<account>").
        env.DB.prepare("DELETE FROM counters WHERE k LIKE 'up:%' AND k < ?1").bind("up:" + (Math.floor(currentTime / DAY) - 1) + ":"),
        env.DB.prepare("DELETE FROM settings WHERE k LIKE 'alerted:%' AND k < ?1")
            .bind("alerted:" + new Date((currentTime - 2 * DAY) * 1000).toISOString().slice(0, 10)),
    ]);
}

// Emails the owner through Cloudflare Email Routing, if it's set up.
async function sendAlert(env: Env, subject: string, text: string): Promise<void>
{
    if (!env.ALERT_EMAIL || !env.ALERT_FROM || !env.ALERT_TO) return;

    const { EmailMessage } = await import("cloudflare:email");
    const raw =
    [
        `From: Sterling Quest Sync <${env.ALERT_FROM}>`,
        `To: ${env.ALERT_TO}`,
        `Subject: ${subject}`,
        `Message-ID: <${crypto.randomUUID()}@${env.ALERT_FROM.split("@")[1]}>`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
    ].join("\r\n");

    await env.ALERT_EMAIL.send(new EmailMessage(env.ALERT_FROM, env.ALERT_TO, raw));
}

// Warns the owner by email when free-plan usage passes the alert level.
export async function usageCheck(env: Env): Promise<void>
{
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return;

    const threshold = Number(env.USAGE_ALERT_PCT || "60");
    const usage = await fetchUsage(env.CF_ACCOUNT_ID, env.CF_API_TOKEN);
    const pct = percentages(usage);
    const over = (Object.keys(pct) as (keyof typeof pct)[]).filter((resource) => pct[resource] >= threshold);

    if (!over.length) return;

    // One email per day: remember that today's alert went out.
    const flag = "alerted:" + usage.date;
    const done = await env.DB.prepare("SELECT 1 FROM settings WHERE k = ?1").bind(flag).first();

    if (done) return;

    const lines =
    [
        `Cloudflare usage for ${usage.date} (UTC) has passed ${threshold}% of a Workers Free daily limit.`,
        "",
        `Requests:         ${usage.requests} of ${FREE_LIMITS.requests} (${pct.requests.toFixed(0)}%)`,
        `D1 rows read:     ${usage.rowsRead} of ${FREE_LIMITS.rowsRead} (${pct.rowsRead.toFixed(0)}%)`,
        `D1 rows written:  ${usage.rowsWritten} of ${FREE_LIMITS.rowsWritten} (${pct.rowsWritten.toFixed(0)}%)`,
        "",
        "These numbers are account-wide, so other Workers on the account count too.",
        "If this keeps happening, turn on Workers Paid ($5/month) in the Cloudflare dashboard.",
    ];

    await sendAlert(env, `Sterling Quest Sync: usage past ${threshold}% (${over.join(", ")})`, lines.join("\n"));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES (?1, '1')").bind(flag).run();
}

/** Heartbeat for the owner's admin tool: when the hourly job and the daily cleanup last ran. */
async function mark(env: Env, flagKey: string, currentTime = now()): Promise<void>
{
    await env.DB.prepare("INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(flagKey, String(currentTime)).run();
}

// The cron entry point: runs the cleanup and the usage check.
export async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>
{
    ctx.waitUntil(usageCheck(env).catch((error) => console.error("usage check failed", error instanceof Error ? error.message.slice(0, 200) : "")));

    await mark(env, "cron:last");

    if (new Date().getUTCHours() === CLEANUP_HOUR_UTC)
    {
        await cleanup(env);
        await mark(env, "cleanup:last");
    }
}
