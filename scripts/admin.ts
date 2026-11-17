// Owner jobs from the command line. The same jobs have a window: `npm run admin-ui`.
//
//   npm run admin accounts          list accounts, newest activity first
//   npm run admin ban <id>          lock an account out and end its pairings
//   npm run admin unban <id>
//   npm run admin signups on|off    on = open sign-up, off = invite-only
//   npm run admin notices           list the notices apps are shown (post them in the window)
//   npm run admin stats             counts, plus today's Cloudflare usage if a token is set

import { accounts, ban, signups, stats, notices, AdminError } from "./admin-lib";

const day = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "");

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "accounts": {
      const rows = await accounts();
      console.table(rows.map((r) => ({
        account: r.account,
        characters: r.characters.slice(0, 40),
        pairings: r.pairings,
        pcs: r.pcs,
        created: day(r.created),
        last_seen: day(r.last_seen),
        banned: r.banned ? "BANNED" : "",
      })));
      break;
    }
    case "ban": console.log(await ban(arg ?? "", true)); break;
    case "unban": console.log(await ban(arg ?? "", false)); break;
    case "signups": console.log(await signups(arg ?? "")); break;
    case "notices": console.table(await notices()); break;
    case "stats": {
      const s = await stats();
      console.log("Database");
      console.table(s.db);
      if (s.usage) {
        console.log(`Cloudflare usage today (${s.usage.date}, UTC, whole account)`);
        console.table(Object.fromEntries(s.usage.rows.map((r) => [r.name, { used: r.used, limit: r.limit, percent: r.percent.toFixed(1) }])));
      } else if (s.usage_note) console.log(s.usage_note);
      break;
    }
    default:
      console.log("Commands: accounts | ban <id> | unban <id> | signups on|off | notices | stats");
  }
}

main().catch((e) => {
  console.error(e instanceof AdminError ? e.message : e);
  process.exit(1);
});
