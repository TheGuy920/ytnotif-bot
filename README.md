# ytnotif-bot

A Cloudflare Worker that turns YouTube upload notifications into Discord posts. It's the serverless replacement
for the old `yt-pubsub-discord` Node/pm2 service, and it runs on Cloudflare's free plan.

```
YouTube ──(WebSub hub)──▶ Worker /notifs ──▶ is it configured? new? not a Short? ──▶ Discord webhook
                              ▲
             daily cron ──────┘ re-subscribes every channel with the hub (leases last 5 days)
```

For each notification the Worker:

1. checks the hub's signature (if `HUB_SECRET` is set),
2. replies `204` immediately and does the rest in the background,
3. looks up the channel in [`src/config.js`](src/config.js),
4. skips videos it has already announced (see [Seen list](#seen-list)),
5. skips Shorts for channels with `filterShorts`,
6. renders the message template and posts it to that channel's Discord webhook.

---

## Setup guide

You'll need:

- a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) 18 or newer
- this repo cloned locally: `git clone https://github.com/TheGuy920/ytnotif-bot && cd ytnotif-bot && npm install`

### 1. Discord: create the webhooks

Do this for each Discord channel you want posts in:

1. Open **Server Settings → Integrations → Webhooks → New Webhook**.
2. Choose the channel, and set the name and avatar you want posts to show. The bot always uses the webhook's own
   name and avatar.
3. Click **Copy Webhook URL** and keep it somewhere for step 4. It looks like
   `https://discord.com/api/webhooks/<id>/<token>`.

> Treat webhook URLs like passwords: anyone with one can post to your channel. If one leaks, delete the webhook
> in Discord and create a new one. They never go in git; they're stored as Cloudflare secrets.

### 2. Configure your channels

Edit [`src/config.js`](src/config.js). Each channel lists its YouTube channel ID and the **name of the secret**
that holds its Discord webhook URL:

```js
{ name: 'bashbunni', channelId: 'UC9H0HzpKf5JlazkADWnW1Jw', webhook: 'WEBHOOK_BASHBUNNI', filterShorts: true },
```

Channels posting to the same Discord channel can share a secret name. To find a channel ID, open the channel
page, then **About → Share channel → Copy channel ID**. It starts with `UC`.

### 3. Cloudflare: storage and first deploy

```bash
npx wrangler login                     # opens a browser to authorize wrangler
npx wrangler kv namespace create SEEN  # prints an id
```

Paste the printed `id` into `kv_namespaces` in [`wrangler.jsonc`](wrangler.jsonc), replacing
`REPLACE_WITH_KV_NAMESPACE_ID`. The id isn't secret, so it's fine to commit.

Then deploy once to get the Worker's URL:

```bash
npm run deploy
# ... Deployed ytnotif-bot ... https://ytnotif-bot.<your-subdomain>.workers.dev
```

### 4. Set the callback URL and secrets

**Yes, the Worker's URL has to be in the config.** The hub needs a callback URL to send notifications to. The
daily re-subscribe runs from a cron job, which has no incoming request, so the Worker can't find out its own
public address. Set it in [`wrangler.jsonc`](wrangler.jsonc):

```jsonc
"CALLBACK_URL": "https://ytnotif-bot.<your-subdomain>.workers.dev/notifs"
```

Until this is changed from the placeholder, the Worker won't subscribe anything.

Next, add the secrets: one per `webhook` name in `src/config.js`, plus two optional ones.

```bash
npx wrangler secret put WEBHOOK_BASHBUNNI   # paste the Discord webhook URL when prompted
npx wrangler secret put WEBHOOK_AXOLOT
npx wrangler secret put HUB_SECRET          # recommended: any long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put ADMIN_TOKEN         # optional: lets you trigger a re-subscribe by hand
```

Secrets stay in place across deploys; set each one once. Then deploy again so the new `CALLBACK_URL` is live:

```bash
npm run deploy
```

### 5. Subscribe and check it works

The cron subscribes everything daily at 04:17 UTC. To subscribe right away instead (requires `ADMIN_TOKEN`):

```bash
curl -X POST https://ytnotif-bot.<your-subdomain>.workers.dev/resubscribe \
  -H "Authorization: Bearer <your ADMIN_TOKEN>"
```

You should see one `accepted` line per channel. Watch the logs while the hub verifies each subscription:

```bash
npm run tail
# [verify] hub.mode=subscribe hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC...
```

From then on, each new upload logs a `[notify]` line and shows up in Discord. You can also read the logs in the
dashboard under **Workers & Pages → ytnotif-bot → Logs**.

### 6. GitHub: auto-deploy on push (optional)

**Option A: Cloudflare Workers Builds (recommended, no GitHub secrets needed)**

1. In the Cloudflare dashboard, open **Workers & Pages → ytnotif-bot → Settings → Build**.
2. Click **Connect**, authorize the Cloudflare GitHub app for `TheGuy920/ytnotif-bot`, and pick the `main`
   branch.
3. Keep the default deploy command, `npx wrangler deploy`.

Every push to `main` then deploys automatically. Secrets you set with `wrangler secret put` are kept.

**Option B: GitHub Actions**

Create an API token at **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template. Add it as
the repo secret `CLOUDFLARE_API_TOKEN`, and add your account ID (shown on the dashboard's Workers overview page)
as `CLOUDFLARE_ACCOUNT_ID`. Then add `.github/workflows/deploy.yml`:

```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm test
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Either way, the included [`test` workflow](.github/workflows/test.yml) runs the unit tests and a dry-run build on
every PR.

### 7. Retire the old server

The old pm2 service has its own hub subscriptions pointing at its own callback URLs, and they stay active until
their leases expire (up to 5 days). If both services run at once, every video gets posted twice. Once the Worker
has posted its first video, stop the old one:

```bash
pm2 stop yt-pubsub-discord && pm2 delete yt-pubsub-discord
```

### Using your own domain (optional)

If `theguy920.dev` is on Cloudflare, you can serve the Worker from it: **ytnotif-bot → Settings → Domains &
Routes → Add → Custom domain**, e.g. `yt.theguy920.dev`. Then set
`CALLBACK_URL` to `https://yt.theguy920.dev/notifs` and redeploy.

---

## Day-to-day

| I want to…                  | Do this                                                                                     |
|-----------------------------|---------------------------------------------------------------------------------------------|
| Add a channel               | Add a line to `src/config.js`, deploy, then call `/resubscribe` or wait for the cron.        |
| Remove a channel            | Delete its line and deploy. Its subscription lapses within 5 days because the Worker refuses the renewal. |
| Change the message          | Edit `TEMPLATE` (or a channel's `template`) in `src/config.js` and deploy.                  |
| Swap a Discord webhook      | `npx wrangler secret put WEBHOOK_…` with the new URL. Takes effect immediately.             |
| Watch what's happening      | `npm run tail`                                                                              |
| See what's been announced   | `npx wrangler kv key get seen --binding SEEN --remote`                                      |
| Force a video to post again | Delete its line from the `seen` value (via the dashboard's KV editor, or get, edit, then `kv key put`). |

---

## Reference

### Channel options (`src/config.js`)

| Field             | Default        | Description                                                                       |
|-------------------|----------------|-----------------------------------------------------------------------------------|
| `name`            | (required)     | Label used in logs.                                                               |
| `channelId`       | (required)     | YouTube channel ID (`UC...`).                                                     |
| `webhook`         | (required)     | Name of the Worker secret that holds the Discord webhook URL.                     |
| `filterShorts`    | `true`         | Skip Shorts.                                                                      |
| `announceUpdates` | `false`        | Re-post when YouTube pings an already-announced video again (e.g. a title edit).  |
| `callbackUrl`     | `CALLBACK_URL` | Per-channel callback override (e.g. a different domain).                          |
| `template`        | `TEMPLATE`     | Per-channel Discord payload.                                                      |

### Vars (`wrangler.jsonc`)

| Var             | Description                                                                                        |
|-----------------|----------------------------------------------------------------------------------------------------|
| `CALLBACK_URL`  | Public URL the hub calls. Notifications are accepted on this URL's path (`/notifs`).               |
| `SEEN_TTL_DAYS` | How long an announced video is remembered, counted from its publish date (default 30).             |

### Secrets

| Secret          | Required | Description                                                                 |
|-----------------|----------|-----------------------------------------------------------------------------|
| `WEBHOOK_*`     | yes      | One per `webhook` name in `src/config.js`; the Discord webhook URL.         |
| `HUB_SECRET`    | no       | Lets the Worker verify that notifications really come from the hub.         |
| `ADMIN_TOKEN`   | no       | Enables `POST /resubscribe` with `Authorization: Bearer <token>`.           |

### Endpoints

| Request               | Purpose                                                                         |
|-----------------------|---------------------------------------------------------------------------------|
| `GET /notifs`         | Hub verification handshake. Only confirms channels that are in the config.      |
| `POST /notifs`        | Hub notifications.                                                              |
| `POST /resubscribe`   | Re-subscribe all channels now (needs `ADMIN_TOKEN`).                            |

### Templates

A template is a Discord webhook payload. Any string in it can use these placeholders: `{{videoId}}`,
`{{videoUrl}}`, `{{videoTitle}}`, `{{channelId}}`, `{{channelName}}`, `{{channelUrl}}`, `{{publishedAt}}`,
`{{updatedAt}}`.

```js
template: {
    content: 'New video from **{{channelName}}**!',
    embeds: [{ title: '{{videoTitle}}', url: '{{videoUrl}}', color: 16711680, timestamp: '{{publishedAt}}' }],
},
```

`username` and `avatar_url` are always stripped, so posts use the webhook's own name and avatar.

### Seen list

The seen list is one plain-text KV value (key `seen`) with one line per announced video:

```
channelId:videoId:expiresAtUnixSeconds
```

The expiry is the video's publish time plus `SEEN_TTL_DAYS`. Expired lines are dropped the next time the list is
written. Notifications for videos published more than `SEEN_TTL_DAYS` ago are ignored outright, because they're
edit pings on old videos. That's why letting entries expire can't cause a re-post.

Each notification does one KV read, and KV is written only after a post, so this stays well inside the free tier
(100k reads and 1k writes per day).

---

## Troubleshooting

- **Nothing posts.** Run `npm run tail` and wait for an upload, or check that `/resubscribe` printed `accepted`.
  No `[verify]` lines after subscribing usually means `CALLBACK_URL` is wrong.
- **`Secret WEBHOOK_… is not set`.** The secret name in `src/config.js` doesn't match one you created. Check with
  `npx wrangler secret list`.
- **`Discord webhook failed: 401 Invalid Webhook Token`.** The webhook was deleted or regenerated. Create a new
  one and `secret put` it again.
- **`[verify] Refusing subscribe for unconfigured topic`.** The hub is renewing a channel that's no longer in
  `src/config.js`. This is expected after removing a channel.
- **Deploy fails mentioning the KV namespace.** The `REPLACE_WITH_KV_NAMESPACE_ID` placeholder is still in
  `wrangler.jsonc` (step 3).
- **Every video posts twice.** The old server is probably still running (step 7).

## Development

```bash
npm test        # unit tests (node:test)
npm run dev     # local Worker on :8787; GET /__scheduled runs the cron handler
```

For local runs, put secrets in `.dev.vars` (gitignored):

```
WEBHOOK_BASHBUNNI=https://discord.com/api/webhooks/...
CALLBACK_URL=http://localhost:8787/notifs
```

### Project layout

```
src/
  index.js     request routing, notification handling, cron
  config.js    channels + message template
  feed.js      Atom payload parser
  seen.js      seen-list format
  discord.js   template rendering + webhook sender
  hub.js       hub subscribe + signature check
  shorts.js    Shorts detection
test/          unit tests + fixture payloads
```
