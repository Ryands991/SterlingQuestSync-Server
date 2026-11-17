# Sterling Quest Sync Companion, server

**For use with the [Sterling Quest Sync](https://github.com/SterlingAddons/SterlingQuest) add-on** (formerly Sterling Quest Tracker) **and its optional Companion app.** Start at the add-on's page for the big picture of what it does and how the pieces fit together. This page is all about the sync server.

**You don't need to run this.** The [Sterling Quest Sync Companion app](https://github.com/SterlingAddons/SterlingQuestSync-App) connects to my server at `sync.sterlingaddons.com`, free for everyone. This repo is the code behind it, here so you can see exactly what it does, or run your own if you'd rather.

**Status:** Still in heavy development and not finished yet. Things are mostly settled now, but big changes can still come with an update.

**Access:** Sign-up is open. The app makes your account the first time you run it, with no email or password. To run your own instead, see the [setup guide](SETUP.md).

## What this is

The Sterling Quest Sync add-on already syncs quest progress live between friends who are online together. This server covers the rest: when your play times don't overlap, the [Sterling Quest Sync Companion app](https://github.com/SterlingAddons/SterlingQuestSync-App) shares your progress each time the game saves (when you log out or /reload), and your friend's app picks it up before they log in.

It's one Cloudflare Worker and one D1 database. The server is a mailbox: it keeps the latest full copy per character and partner, checks who may read what, and numbers every upload. It never runs anything in the game, and it treats the copies it carries as opaque.

Related: [Sterling Quest Sync add-on](https://github.com/SterlingAddons/SterlingQuest) · [Sterling Quest Sync Companion app](https://github.com/SterlingAddons/SterlingQuestSync-App)

## How it stays safe

- **Who you are comes only from your key.** The app makes a random 256-bit key on each PC. The server stores only its SHA-256.
- **Data only flows through a pairing.** One friend's app makes a pairing code, the other redeems it (typed in by hand, or passed between the two apps through Sterling in game when they're already partners there). Codes are random, single use, expire in 24 hours, and are rate limited. Nobody can send a request to a stranger, and listing a character's GUID grants nothing.
- **Newest save wins.** Uploads carry the game's server time from the save, and the server refuses older ones.
- **Fair use for everyone.** Each account can save up to 1,000 uploads a day, a save can't be dated more than a day ahead, and every request is rate limited per address and per key. The public server also has a Cloudflare rate limiting rule in front of it.
- **Strict input.** Copies must match `^[A-Za-z0-9()]+$` and stay under 64 KB. Every query uses bound parameters. There are no listing endpoints.
- **No admin API.** Owner jobs run in Sterling Admin, a separate tool in this repo that runs only on the owner's PC, through Wrangler and their Cloudflare login (or a token limited to D1 and analytics). The Sterling Quest Sync app has no owner code. See [SETUP.md](SETUP.md#5-owner-jobs-sterling-admin).
- **The trust we accept:** pair signing keys pass through the server, so whoever runs a server could forge partner progress. It can't run code in anyone's game or touch a character.

`test/attacks.test.ts` is the bad-actor suite and `test/audit.test.ts` holds the findings of the November 2026 security audit. Every attack in them must fail, and they run with every change.

Found a security problem? Please report it privately through the app repo's [security page](https://github.com/SterlingAddons/SterlingQuestSync-App/security/advisories/new) or email support@sterlingaddons.com.

## Privacy

What's stored:

- Your account (a random ID), and for each PC a hashed key, a label you pick and when it was last seen.
- The characters you list: GUID, name and realm.
- Your pairings, and the latest copy of your quest log and finished quests for each partner (and one for your own other PCs).
- When each copy was uploaded. Upload times show roughly when you play.

What isn't: no email, no password, no IP addresses, no WoW account names.

- Quest copies are packed, **not encrypted**. Whoever runs the server can read them.
- **Expiry:** accounts that never pair are removed after 7 days. Copies nobody has touched in about 30 days are removed. Accounts idle for about 12 months are removed with their pairings.
- **Delete my data** in the app removes your account, PCs, characters, pairings and copies right away. Copies already delivered to a friend's PC stay on their PC.
- Cloudflare keeps a short restore history of the database (Time Travel: 7 days on the free plan, 30 on paid), so deleted data can linger there for that long.

## Run your own

See [SETUP.md](SETUP.md). It works on a free Cloudflare account.

## Developing

```sh
npm install
npm test          # runs the API and bad-actor tests against a local D1
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).

> Built by Sterling with the help of Claude, an AI model by Anthropic. The ideas, testing and decisions are mine; much of the code was written with Claude. Everything is tested in game with friends.
