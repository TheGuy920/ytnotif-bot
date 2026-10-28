# ytnotif-bot

A Cloudflare Worker that turns YouTube upload notifications into Discord posts. It runs on Cloudflare's free plan
and has no runtime dependencies.

Channels are managed **at runtime** from a built-in admin page (or its JSON API). Adding a channel subscribes it
with YouTube's hub immediately, and removing one unsubscribes it. Neither needs a redeploy. The Worker's
homepage is a public status page listing every tracked channel, its subscription health, and the last video
posted.

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
- your own fork of this repo (needed for auto-deploys in step 6), cloned locally:
  `git clone https://github.com/<you>/ytnotif-bot && cd ytnotif-bot && npm install`

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

Keep the printed `id`; you'll pass it in as `KV_STORE_ID`. It never goes in git: the KV entries in
[`wrangler.jsonc`](wrangler.jsonc) hold the placeholder `"KV_STORE_ID"`, and
[`scripts/inject-kv-id.mjs`](scripts/inject-kv-id.mjs) fills in the real id from the `KV_STORE_ID` environment
variable before each deploy. (`wrangler.jsonc` can't read environment variables itself.)

Set the secrets:

```bash
npx wrangler secret put ADMIN_TOKEN   # required: the password for the admin page, e.g. `openssl rand -hex 24`
npx wrangler secret put HUB_SECRET    # recommended: any long random string, e.g. `openssl rand -hex 32`
```

Deploy:

```bash
KV_STORE_ID=<your namespace id> npm run deploy
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
- The status line shows whether the hub accepted the request. Click **hub status** to open Google's page for that
  subscription; within a minute or so its state should be `verified`. The link includes `HUB_SECRET`, because the
  hub only shows a secret-protected subscription to someone who supplies the secret. Don't share that link.
- The Worker's homepage (`https://ytnotif-bot.<your-subdomain>.workers.dev/`) shows the same health for everyone,
  without the admin token.

<details>
<summary><b>Importing many channels in one go</b></summary>

[`channels.example.json`](channels.example.json) shows the format, with placeholder channel IDs. Each `webhook` is
either a Discord webhook URL or the name of a Worker secret holding one. Set any secrets you reference first, then
upload the file:

```bash
npx wrangler secret put WEBHOOK_MAIN

curl -X PUT https://ytnotif-bot.<your-subdomain>.workers.dev/api/channels \
  -H "Authorization: Bearer <ADMIN_TOKEN>" --data @channels.example.json
```

`PUT /api/channels` replaces the whole list. Channels missing from the new list are unsubscribed.
</details>

### 5. Watch it work

```bash
npm run tail
# [verify] hub.mode=subscribe hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC...
# [notify] [My Channel] abc123 "New video" published=...
# [notify] [My Channel] abc123 Posted to Discord.
```

You can also read the logs in the dashboard under **Workers & Pages → ytnotif-bot → Logs**.

### 6. GitHub: auto-deploy on push (optional)

Only code changes need a deploy. Channel changes don't.

**Option A: Cloudflare Workers Builds (recommended, no GitHub secrets needed)**

1. In the Cloudflare dashboard, open **Workers & Pages → ytnotif-bot → Settings → Build**.
2. Click **Connect**, authorize the Cloudflare GitHub app for your fork of this repo, and pick the `main`
   branch.
3. Under **Variables and secrets** (build variables, not the Worker's runtime variables), add `KV_STORE_ID` with
   your namespace id.
4. Set the **Build command** to `node scripts/inject-kv-id.mjs`. It runs before the deploy command on every
   build, production and preview. Keep the default deploy commands (`npx wrangler deploy`, and
   `npx wrangler preview` for other branches).

If the build variable is missing, the build stops at step 4 with an error saying so, rather than deploying.

Every push to `main` then deploys automatically. Secrets and KV data are kept across deploys.

Pushes to other branches (including PRs) run `wrangler preview` instead, which needs the `previews` block in
`wrangler.jsonc`. Previews bind the same KV namespace as production so their pages show real data, with
`READ_ONLY` set: a preview's admin page can list channels but not change them. Without that, saving a channel
from a preview would move its hub subscription to the preview URL. Previews don't run the cron, and the hub never
calls them.

**Option B: GitHub Actions**

Create an API token at **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template. Add it as
the repo secret `CLOUDFLARE_API_TOKEN`, add your account ID (shown on the dashboard's Workers overview page)
as `CLOUDFLARE_ACCOUNT_ID`, and add your namespace id as `KV_STORE_ID`. Then add `.github/workflows/deploy.yml`:

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
      - run: node scripts/inject-kv-id.mjs
        env:
          KV_STORE_ID: ${{ secrets.KV_STORE_ID }}
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Either way, the included [`test` workflow](.github/workflows/test.yml) runs the unit tests and a dry-run build on
every PR.

### Using your own domain (optional)

If your domain is on Cloudflare, add **ytnotif-bot → Settings → Domains & Routes → Add → Custom domain**,
e.g. `yt.example.com`. Then open the admin page on that domain and click **Renew all subscriptions**. Every
channel moves its callback to the new host, and the old callback is unsubscribed.

---

## Day-to-day

| I want to…                  | Do this                                                                                     |
|-----------------------------|---------------------------------------------------------------------------------------------|
| Add / remove a channel      | Admin page. Takes effect immediately.                                                       |
| Change a message template   | Admin page → **Edit** → *Custom message template*.                                          |
| Swap a Discord webhook      | Admin page → **Edit**, paste the new URL. Leaving the field blank keeps the current one.    |
| Check subscriptions         | Status line and **hub status** per channel; **Renew all subscriptions** to force a renewal. |
| Watch what's happening      | `npm run tail`                                                                              |
| See what's been announced   | `npx wrangler kv key get seen --namespace-id $KV_STORE_ID --remote`                         |
| Force a video to post again | Delete its line from the `seen` key (dashboard: **Storage & Databases → KV → STORE**).      |

---

## Reference

### Admin API

Every request needs `Authorization: Bearer <ADMIN_TOKEN>`. Bodies are JSON.

| Request                          | Purpose                                                                        |
|----------------------------------|--------------------------------------------------------------------------------|
| `GET /api/channels`              | List channels (webhook tokens masked, plus a `hubStatusUrl` that includes `HUB_SECRET`) and the current callback URL. |
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
curl -X PUT https://<host>/api/channels/UCxxxxxxxxxxxxxxxxxxxxxx \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"webhook":"https://discord.com/api/webhooks/123/abc","filterShorts":true}'
```

### Other endpoints

| Request          | Purpose                                                       |
|------------------|---------------------------------------------------------------|
| `GET /admin`     | Admin page.                                                   |
| `GET /notifs`    | Hub verification handshake.                                   |
| `POST /notifs`   | Hub notifications.                                            |
| `GET` anything else | Public status page: channel names, subscription health, last post. Never shows webhooks or secrets. Cached for 60 s. |

### Vars and secrets

| Name            | Kind   | Description                                                                              |
|-----------------|--------|------------------------------------------------------------------------------------------|
| `ADMIN_TOKEN`   | secret | **Required** for the admin page/API. Without it, they return 503.                        |
| `HUB_SECRET`    | secret | Recommended. Lets the Worker verify that notifications really come from the hub.         |
| `WEBHOOK_*`     | secret | Optional. Discord webhook URLs referenced by name from channels.                         |
| `READ_ONLY`     | var    | `"true"` makes the admin API reject every change. Set for Worker Previews.            |
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
- **`last:<channelId>`**: the last video posted for each channel, shown on the status page.

#### Seen list

The seen list is plain text, one line per announced video:

```
channelId:videoId:expiresAtUnixSeconds
```

The expiry is the video's publish time plus `SEEN_TTL_DAYS`. Expired lines are dropped the next time the list is
written. Notifications for videos published more than `SEEN_TTL_DAYS` ago are ignored outright, because they're
edit pings on old videos. That's why letting entries expire can't cause a re-post.

### Free plan budget

- **Notifications:** two KV reads each (channels and seen). KV is written only after a post (seen list plus the
  channel's `last:` key).
- **Status page:** one KV read plus one per channel, per uncached view. With 10 channels that's about 9,000 views
  a day before reaching the free tier's 100k reads.
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
- **"The specified secret is incorrect" on Google's hub page.** The URL is missing `&hub.secret=<HUB_SECRET>`.
  The admin page's **hub status** link adds it for you.
- **"Discord rejected the webhook URL".** The webhook was deleted or regenerated. Create a new one.
- **`Secret WEBHOOK_… is not set`.** A channel references a secret name that doesn't exist. Check with
  `npx wrangler secret list`.
- **Build fails with "KV_STORE_ID must be set".** Add the `KV_STORE_ID` build variable (step 6), or prefix a
  local deploy with `KV_STORE_ID=<id>` (step 2).
- **A direct `npx wrangler deploy` fails mentioning the KV namespace.** The placeholder wasn't replaced. Use
  `npm run deploy`, which runs `scripts/inject-kv-id.mjs` first.
- **Workers Builds fails with "missing a `previews` block".** Branch builds run `wrangler preview`, which needs a
  `previews` block in `wrangler.jsonc`. The block in this repo is meant to stay; if you add vars or bindings,
  don't leave `<REPLACE_ME>` placeholders in it, because wrangler rejects those too.
- **A preview's admin page says it's read-only.** Expected; see the previews note in step 6. Make changes on the
  production URL.

## Development

```bash
npm test        # unit tests (node:test)
npm run dev     # local Worker on :8787 with local, empty storage; GET /__scheduled runs the cron
```

To develop against your real data instead, run on Cloudflare with `--remote`. Wrapping the command fills in the id
for that run and puts the placeholder back afterwards, so nothing account-specific ends up in a commit:

```bash
KV_STORE_ID=<id> node scripts/inject-kv-id.mjs npx wrangler dev --remote
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
  status.js      public status page (every other GET)
  channels.js    channel storage + validation, default template
  feed.js        Atom payload parser
  seen.js        seen-list format
  discord.js     template rendering + webhook sender
  hub.js         hub subscribe + signature check
  shorts.js      Shorts detection
scripts/
  inject-kv-id.mjs  fills the KV namespace id into wrangler.jsonc from KV_STORE_ID
test/            unit tests + fixture payloads
channels.example.json   example channel list for a bulk import
```

## License

[GPL-3.0](LICENSE)
