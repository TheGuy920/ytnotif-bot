# ytnotif-bot

A Cloudflare Worker that turns YouTube upload notifications into Discord posts. It's the serverless replacement
for the old `yt-pubsub-discord` Node/pm2 service, and it runs on Cloudflare's free plan.

Channels are managed **at runtime** from a built-in admin page (or its JSON API). Adding a channel subscribes it
with YouTube's hub immediately, and removing one unsubscribes it. Neither needs a redeploy.

```
                         admin page / API ──▶ channel list (KV) ──▶ subscribe / unsubscribe with the hub
                                                     │
YouTube ──(WebSub hub)──▶ Worker /notifs ──▶ tracked? new? not a Short? ──▶ that channel's Discord webhook
                              ▲
              hourly cron ────┘ renews subscriptions older than a day (leases last 5 days)
```

For each notification the Worker:

1. checks the hub's signature (if `HUB_SECRET` is set),
2. replies `204` immediately and does the rest in the background,
3. looks up the channel in the tracked list,
4. skips videos it has already announced (see [Seen list](#seen-list)),
5. skips Shorts for channels with "Skip Shorts" on,
6. renders the channel's message template and posts it to the channel's Discord webhook.

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
3. Click **Copy Webhook URL**. It looks like `https://discord.com/api/webhooks/<id>/<token>`. You'll paste it into
   the admin page in step 4.

> Treat webhook URLs like passwords: anyone with one can post to your channel. If one leaks, delete the webhook
> in Discord and create a new one. They never go in git.

### 2. Cloudflare: storage, secrets, deploy

```bash
npx wrangler login                      # opens a browser to authorize wrangler
npx wrangler kv namespace create STORE  # prints an id
```

Paste the printed `id` into `kv_namespaces` in [`wrangler.jsonc`](wrangler.jsonc), replacing
`REPLACE_WITH_KV_NAMESPACE_ID`. The id isn't secret, so it's fine to commit.

Set the secrets:

```bash
npx wrangler secret put ADMIN_TOKEN   # required: the password for the admin page, e.g. `openssl rand -hex 24`
npx wrangler secret put HUB_SECRET    # recommended: any long random string, e.g. `openssl rand -hex 32`
```

Deploy:

```bash
npm run deploy
# ... Deployed ytnotif-bot ... https://ytnotif-bot.<your-subdomain>.workers.dev
```

> **Callback URL:** there's nothing to configure. When you add a channel, the Worker tells the hub to call back
> to the host you're using the admin page on (`https://<that host>/notifs`) and stores that URL with the
> channel, so the hourly renewals reuse it. To pin one URL regardless, set `CALLBACK_URL` in `wrangler.jsonc`.

### 3. Open the admin page

Go to `https://ytnotif-bot.<your-subdomain>.workers.dev/admin` and sign in with your `ADMIN_TOKEN`. The token is
kept in that browser's local storage. Use **Sign out** on shared machines.

### 4. Add channels

Fill in the **Add a channel** form:

| Field             | What to enter                                                                                     |
|-------------------|---------------------------------------------------------------------------------------------------|
| YouTube channel   | The channel ID (`UC…`) or a `youtube.com/channel/UC…` URL. To find the ID: channel page → **About → Share channel → Copy channel ID**. |
| Name              | Optional label. If left blank, it's looked up from YouTube.                                       |
| Discord webhook   | The webhook URL from step 1. It's checked with Discord before saving.                             |
| Skip Shorts       | On by default.                                                                                    |
| Re-post edits     | Post again when YouTube re-pings an already-announced video (e.g. a title edit).                  |
| Custom template   | Optional. See [Templates](#templates).                                                            |

Saving adds the channel and asks the hub to subscribe. Then:

- Click **Test** to send a sample message to that channel's webhook.
- The status line shows whether the hub accepted the request. **hub status** opens Google's subscription page
  for that channel, which should say `verified` within a minute or so.

<details>
<summary><b>Importing the old server's channels in one go</b></summary>

[`channels.example.json`](channels.example.json) lists the 7 channels from the old `config.json`. Their webhooks
reference secret names instead of URLs, so set those first, then upload the file:

```bash
npx wrangler secret put WEBHOOK_BASHBUNNI
npx wrangler secret put WEBHOOK_AXOLOT

curl -X PUT https://ytnotif-bot.<your-subdomain>.workers.dev/api/channels \
  -H "Authorization: Bearer <ADMIN_TOKEN>" --data @channels.example.json
```

`PUT /api/channels` replaces the whole list. Channels missing from the new list are unsubscribed.
</details>

### 5. Watch it work

```bash
npm run tail
# [verify] hub.mode=subscribe hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC...
# [notify] [bashbunni] abc123 "New video" published=...
# [notify] [bashbunni] abc123 Posted to Discord.
```

You can also read the logs in the dashboard under **Workers & Pages → ytnotif-bot → Logs**.

### 6. GitHub: auto-deploy on push (optional)

Only code changes need a deploy. Channel changes don't.

**Option A: Cloudflare Workers Builds (recommended, no GitHub secrets needed)**

1. In the Cloudflare dashboard, open **Workers & Pages → ytnotif-bot → Settings → Build**.
2. Click **Connect**, authorize the Cloudflare GitHub app for `TheGuy920/ytnotif-bot`, and pick the `main`
   branch.
3. Keep the default deploy command, `npx wrangler deploy`.

Every push to `main` then deploys automatically. Secrets and KV data are kept across deploys.

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
their leases expire (up to 5 days). If both services run at once, channels with "re-post edits" can post twice.
Once the Worker has posted its first video, stop the old one:

```bash
pm2 stop yt-pubsub-discord && pm2 delete yt-pubsub-discord
```

### Using your own domain (optional)

If `theguy920.dev` is on Cloudflare, add **ytnotif-bot → Settings → Domains & Routes → Add → Custom domain**,
e.g. `yt.theguy920.dev`. Then open the admin page on that domain and click **Renew all subscriptions**. Every
channel moves its callback to the new host, and the old callback is unsubscribed.

---

## Day-to-day

| I want to…                  | Do this                                                                                     |
|-----------------------------|---------------------------------------------------------------------------------------------|
| Add / remove a channel      | Admin page. Takes effect immediately.                                                       |
| Change a message template   | Admin page → **Edit** → *Custom message template*.                                          |
| Swap a Discord webhook      | Admin page → **Edit**, paste the new URL. Leaving the field blank keeps the current one.    |
| Check subscriptions         | Status line and **hub status** link per channel; **Renew all subscriptions** to force a renewal. |
| Watch what's happening      | `npm run tail`                                                                              |
| See what's been announced   | `npx wrangler kv key get seen --binding STORE --remote`                                     |
| Force a video to post again | Delete its line from the `seen` key (dashboard: **Storage & Databases → KV → STORE**).      |

---

## Reference

### Admin API

Every request needs `Authorization: Bearer <ADMIN_TOKEN>`. Bodies are JSON.

| Request                          | Purpose                                                                        |
|----------------------------------|--------------------------------------------------------------------------------|
| `GET /api/channels`              | List channels (webhook tokens masked) and the current callback URL.            |
| `PUT /api/channels/<channelId>`  | Add or update one channel, then subscribe it. Omitted fields keep their value. |
| `DELETE /api/channels/<channelId>` | Remove a channel and unsubscribe it.                                         |
| `POST /api/channels/<channelId>/test` | Send a sample message to the channel's webhook.                           |
| `PUT /api/channels`              | Replace the whole list (array). New channels are subscribed, removed ones unsubscribed. |
| `POST /api/resubscribe`          | Renew every subscription now.                                                  |

Channel fields:

| Field             | Default    | Description                                                                         |
|-------------------|------------|-------------------------------------------------------------------------------------|
| `webhook`         | (required) | Discord webhook URL, **or** the name of a Worker secret holding one (e.g. `WEBHOOK_MAIN`). Use a secret name to keep the URL out of KV. |
| `name`            | looked up  | Label for logs and the admin page.                                                  |
| `filterShorts`    | `true`     | Skip Shorts.                                                                        |
| `announceUpdates` | `false`    | Re-post when YouTube pings an already-announced video again.                        |
| `template`        | default    | Discord payload object (or a JSON string of one). `""` resets it to the default.    |

Example:

```bash
curl -X PUT https://<host>/api/channels/UC9H0HzpKf5JlazkADWnW1Jw \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"webhook":"https://discord.com/api/webhooks/123/abc","filterShorts":true}'
```

### Other endpoints

| Request          | Purpose                                                       |
|------------------|---------------------------------------------------------------|
| `GET /admin`     | Admin page (also served at `/`).                              |
| `GET /notifs`    | Hub verification handshake.                                   |
| `POST /notifs`   | Hub notifications.                                            |

### Vars and secrets

| Name            | Kind   | Description                                                                              |
|-----------------|--------|------------------------------------------------------------------------------------------|
| `ADMIN_TOKEN`   | secret | **Required** for the admin page/API. Without it, they return 503.                        |
| `HUB_SECRET`    | secret | Recommended. Lets the Worker verify that notifications really come from the hub.         |
| `WEBHOOK_*`     | secret | Optional. Discord webhook URLs referenced by name from channels.                         |
| `SEEN_TTL_DAYS` | var    | How long an announced video is remembered, counted from its publish date (default 30).   |
| `CALLBACK_URL`  | var    | Optional. Pins the hub callback URL instead of using the admin page's host.              |

### Templates

A template is a Discord webhook payload. Any string in it can use these placeholders: `{{videoId}}`,
`{{videoUrl}}`, `{{videoTitle}}`, `{{channelId}}`, `{{channelName}}`, `{{channelUrl}}`, `{{publishedAt}}`,
`{{updatedAt}}`. The default is:

```json
{ "content": "**{{channelName}}** just uploaded!\n{{videoUrl}}" }
```

A richer example:

```json
{
  "content": "New video from **{{channelName}}**!",
  "embeds": [{ "title": "{{videoTitle}}", "url": "{{videoUrl}}", "color": 16711680, "timestamp": "{{publishedAt}}" }]
}
```

`username` and `avatar_url` are always stripped, so posts use the webhook's own name and avatar.

### Storage

Everything lives in the one KV namespace bound as `STORE`:

- **`channels`**: the tracked channels as JSON, including each one's callback URL and last subscribe result.
- **`seen`**: the seen list (below).

#### Seen list

The seen list is plain text, one line per announced video:

```
channelId:videoId:expiresAtUnixSeconds
```

The expiry is the video's publish time plus `SEEN_TTL_DAYS`. Expired lines are dropped the next time the list is
written. Notifications for videos published more than `SEEN_TTL_DAYS` ago are ignored outright, because they're
edit pings on old videos. That's why letting entries expire can't cause a re-post.

### Free plan budget

- **Notifications:** two KV reads each (channels and seen). KV is written only after a post.
- **Cron:** runs hourly but only renews subscriptions older than a day, plus failed ones after an hour. That's at
  most 40 per run, which stays under the free plan's 50-outbound-requests limit and copes with any number of
  channels.
- **Bulk import:** each channel costs about two outbound requests, so `PUT /api/channels` handles roughly 20 new
  channels per call.

---

## Troubleshooting

- **Admin page says "Set the ADMIN_TOKEN secret".** Run `npx wrangler secret put ADMIN_TOKEN`.
- **A channel's status shows ✗.** The hub rejected the request, or couldn't be reached. Click **Renew all
  subscriptions** to retry; the cron also retries failed ones hourly.
- **Status is ✓ but nothing posts.** Open **hub status**. If it isn't `verified`, the hub couldn't reach the
  callback URL shown at the top of the admin page. Also check `npm run tail` when a video goes up.
- **"Discord rejected the webhook URL".** The webhook was deleted or regenerated. Create a new one.
- **`Secret WEBHOOK_… is not set`.** A channel references a secret name that doesn't exist. Check with
  `npx wrangler secret list`.
- **Deploy fails mentioning the KV namespace.** The `REPLACE_WITH_KV_NAMESPACE_ID` placeholder is still in
  `wrangler.jsonc` (step 2).
- **Posts show up twice.** The old server is probably still running (step 7).

## Development

```bash
npm test        # unit tests (node:test)
npm run dev     # local Worker on :8787; /admin works locally, GET /__scheduled runs the cron
```

For local runs, put secrets in `.dev.vars` (gitignored):

```
ADMIN_TOKEN=dev
WEBHOOK_MAIN=https://discord.com/api/webhooks/...
```

### Project layout

```
src/
  index.js       routing, notification handling, cron entry
  admin.js       admin API + subscription renewal
  admin.html     admin page (served at /admin)
  channels.js    channel storage + validation, default template
  feed.js        Atom payload parser
  seen.js        seen-list format
  discord.js     template rendering + webhook sender
  hub.js         hub subscribe + signature check
  shorts.js      Shorts detection
test/            unit tests + fixture payloads
channels.example.json   the old server's channels, for a one-time import
```
