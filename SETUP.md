# Running your own Sterling Quest Sync Companion server

Everything here works on a free Cloudflare account. You need a domain on Cloudflare for the server's address (for example `sync.example.com`) and [Node.js](https://nodejs.org) 20 or newer.

## 1. Get the code and sign in

```sh
git clone https://github.com/SterlingAddons/SterlingQuestSync-Server.git
cd SterlingQuestSync-Server
npm install
npx wrangler login
```

Turn on two-factor login for your Cloudflare account first. Owner jobs run with your Cloudflare login, so it's the key to your server.

## 2. Create the database

```sh
npx wrangler d1 create sterling-quest-sync
```

Copy `wrangler.example.toml` to `wrangler.toml` (it's git-ignored) and fill in:

- `database_id`: from the command above.
- `routes`: your own address, for example `sync.example.com`.

Then create the tables:

```sh
npx wrangler d1 migrations apply sterling-quest-sync --remote
```

## 3. Deploy

```sh
npx wrangler deploy
```

Check it: open `https://sync.example.com/v1/meta`. You should see `{"api":1,...}`.

Point the Companion app at your address in its setup.

## 4. Optional: usage alert

On the free plan, hitting a daily limit pauses the server until 00:00 UTC (nothing is lost; apps retry). Cloudflare only emails you once a limit is reached, so the server can warn you earlier:

1. In the Cloudflare dashboard, turn on **Email Routing** for your domain and add your own email as a verified destination.
2. In `wrangler.toml`, uncomment `ALERT_FROM`, `ALERT_TO` and the `[[send_email]]` block, with your addresses.
3. Create an API token with only **Account Analytics: Read**, then:

```sh
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler deploy
```

The server checks usage every hour and emails once a day if anything passes `USAGE_ALERT_PCT` (60% by default).

## 4b. Recommended: a rate limiting rule

The free plan stops at 100,000 requests a day, and anyone can send that many. The server's own limits protect the database, but only a rule at Cloudflare's edge protects the request count:

1. In the Cloudflare dashboard, open your domain, then **Security > Security rules > Create rule > Rate limiting rule**.
2. Expression: `(http.host eq "sync.example.com")` with your own address.
3. Same IP, more than **50 requests per 10 seconds**, action **Block** for 10 seconds. (The free plan allows one rule with 10-second windows; a normal sync is far below this.)
4. Deploy.

## 5. Owner jobs: Sterling Admin

Owner jobs are a separate tool that lives in this server folder. They are not part of the Companion app, and the public app has no owner code at all.

**The window.** Double-click `Sterling Admin.cmd` (or run `npm run admin-ui`). It opens a small window with:

- **Overview:** what needs attention (with what to do), server status and response time, today's Cloudflare usage against the free limits, errors and CPU time per request, when the hourly job and daily cleanup last ran, new sign-ups, and what the next cleanup will remove.
- **Accounts:** every account with its characters, pairings and PCs, with Ban and Unban.
- **Sign-ups:** open sign-up, or invite-only (the emergency brake).
- **Back up now:** saves a full copy of the database to `Sterling Admin Backups` in your user folder. It holds everyone's data, so keep it private and outside any synced or shared folder.

How it stays safe: it listens only on `127.0.0.1` with a random port and a random key for each launch, checks the Host and Origin of every request, offers only fixed jobs (no free text), and stops on its own about a minute after the window closes.

**Sign-in.** By default it uses your `wrangler login`, which can manage your whole Cloudflare account. Tighter: make an API token with only **D1: Edit** and **Account Analytics: Read**, for your one account, then double-click `set-admin-token.cmd` and paste it. It's saved to `%USERPROFILE%\.sterling-admin\admin.env`, outside this repo. (Cloudflare can't limit a token to a single D1 database yet, so it covers every D1 database on that account.) You still need `wrangler login` to deploy.

**The command line** does the same jobs:

```sh
npm run admin accounts          # list accounts
npm run admin ban <id>          # lock an account out, end its pairings, remove its data
npm run admin unban <id>
npm run admin signups off       # invite-only: new accounts need an invite from an existing user
npm run admin signups on        # open sign-up again
npm run admin stats             # counts, plus today's usage if the admin token is set
```

## Updating

```sh
git pull
npm install
npx wrangler d1 migrations apply sterling-quest-sync --remote
npx wrangler deploy
```
