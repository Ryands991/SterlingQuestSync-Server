# Running your own Sterling Quest Sync server

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

Point the Sterling Quest Sync app at your address in its setup.

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

## 5. Owner jobs

```sh
npm run admin accounts          # list accounts
npm run admin ban <id>          # lock an account out, end its pairings, remove its data
npm run admin unban <id>
npm run admin signups off       # invite-only: new accounts need an invite from an existing user
npm run admin signups on        # open sign-up again
npm run admin stats             # counts, plus today's usage if .admin.env has a token
```

For `stats`, copy `.admin.env.example` to `.admin.env` (git-ignored) and fill in the same read-only token and account ID.

## Updating

```sh
git pull
npm install
npx wrangler d1 migrations apply sterling-quest-sync --remote
npx wrangler deploy
```
