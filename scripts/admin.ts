// Owner jobs from the command line. The same jobs have a window: `npm run admin-ui`.
//
//   npm run admin accounts          list accounts, newest activity first
//   npm run admin ban <id>          lock an account out and end its pairings
//   npm run admin unban <id>
//   npm run admin signups on|off    on = open sign-up, off = invite-only
//   npm run admin notices           list the notices apps are shown (post them in the window)
//   npm run admin stats             counts, plus today's Cloudflare usage if a token is set

import { accounts, ban, signups, stats, notices, AdminError } from "./admin-lib";

// Unix seconds as a date, or blank.
const day = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "");

// Runs the command-line job named on the command line.
async function main(): Promise<void>
{
    const [cmd, arg] = process.argv.slice(2);

    switch (cmd)
    {
        case "accounts":
        {
            const rows = await accounts();

            console.table(rows.map((row) =>
            ({
                account: row.account,
                characters: row.characters.slice(0, 40),
                pairings: row.pairings,
                pcs: row.pcs,
                created: day(row.created),
                last_seen: day(row.last_seen),
                banned: row.banned ? "BANNED" : "",
            })));

            break;
        }

        case "ban": console.log(await ban(arg ?? "", true)); break;
        case "unban": console.log(await ban(arg ?? "", false)); break;
        case "signups": console.log(await signups(arg ?? "")); break;
        case "notices": console.table(await notices()); break;
        case "stats":
        {
            const report = await stats();

            console.log("Database");
            console.table(report.db);

            if (report.usage)
            {
                console.log(`Cloudflare usage today (${report.usage.date}, UTC, whole account)`);
                console.table(Object.fromEntries(report.usage.rows.map((row) => [row.name, { used: row.used, limit: row.limit, percent: row.percent.toFixed(1) }])));
            }

            else if (report.usage_note) console.log(report.usage_note);
            break;
        }

        default:
            console.log("Commands: accounts | ban <id> | unban <id> | signups on|off | notices | stats");
    }
}

main().catch((error) =>
{
    console.error(error instanceof AdminError ? error.message : error);
    process.exit(1);
});
