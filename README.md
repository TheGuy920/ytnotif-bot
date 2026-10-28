# ytnotif-bot

A Cloudflare Worker that receives YouTube PubSubHubbub (WebSub) notifications and posts new uploads to Discord
webhooks. It is the serverless port of the old `yt-pubsub-discord` Node/pm2 service.

When the hub POSTs a notification, the Worker:

1. checks the `X-Hub-Signature` (if `HUB_SECRET` is set),
2. replies `204` straight away and handles the rest in the background,
3. matches each entry's channel against `src/config.js`,
4. skips videos it has already announced (see [Seen list](#seen-list)),
5. skips Shorts for channels with `filterShorts`,
6. renders the channel's template and posts it to that channel's Discord webhook.

A daily cron re-subscribes every configured channel with the hub. Leases last 5 days, so there's plenty of slack.

Everything fits the Workers free plan: there are no dependencies, every request does one KV read, and KV is
written only after a post.

## Setup

```bash
npm install
npx wrangler login

# 1. KV namespace for the seen list; paste the printed id into wrangler.jsonc
npx wrangler kv namespace create SEEN

# 2. Set CALLBACK_URL in wrangler.jsonc to your Worker's public URL + /notifs
#    (e.g. https://ytnotif-bot.<you>.workers.dev/notifs, or a custom domain)

# 3. Secrets: one per `webhook` name used in src/config.js
npx wrangler secret put WEBHOOK_BASHBUNNI
npx wrangler secret put WEBHOOK_AXOLOT
npx wrangler secret put HUB_SECRET     # optional but recommended, any random string
npx wrangler secret put ADMIN_TOKEN    # optional, enables POST /resubscribe

npm run deploy
```

After the first deploy, subscribe right away instead of waiting for the cron:

```bash
curl -X POST https://ytnotif-bot.<you>.workers.dev/resubscribe -H "Authorization: Bearer $ADMIN_TOKEN"
```

Without `ADMIN_TOKEN`, the subscriptions start at the next daily cron run (04:17 UTC).

Logs: `npm run tail`, or Workers → ytnotif-bot → Logs in the dashboard.

## Configuration

Channels and the message template live in [`src/config.js`](src/config.js). Edit it and run `npm run deploy`.

| Field             | Default    | Description                                                                         |
|-------------------|------------|-------------------------------------------------------------------------------------|
| `name`            | (required) | Label used in logs.                                                                 |
| `channelId`       | (required) | YouTube channel ID (`UC...`).                                                       |
| `webhook`         | (required) | Name of the Worker secret that holds the Discord webhook URL.                       |
| `filterShorts`    | `true`     | Skip Shorts.                                                                        |
| `announceUpdates` | `false`    | Re-post when YouTube pings an already-announced video again (e.g. a title edit).    |
| `callbackUrl`     | `CALLBACK_URL` | Per-channel callback override (e.g. a different custom domain).                 |
| `template`        | `TEMPLATE` | Per-channel Discord payload.                                                        |

`wrangler.jsonc` vars:

| Var             | Description                                                                                        |
|-----------------|----------------------------------------------------------------------------------------------------|
| `CALLBACK_URL`  | Public URL the hub calls. The Worker accepts notifications on this URL's path (`/notifs`).         |
| `SEEN_TTL_DAYS` | How long an announced video is remembered, counted from its publish date (default 30).             |

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

## Seen list

The seen list is one plain-text KV value (key `seen`) with one line per announced video:

```
channelId:videoId:expiresAtUnixSeconds
```

The expiry is the video's publish time plus `SEEN_TTL_DAYS`. Expired lines are dropped the next time the list is
written. Notifications for videos published more than `SEEN_TTL_DAYS` ago are ignored outright, because they are
edit pings on old videos. That's why letting entries expire can't cause a re-post.

To inspect it: `npx wrangler kv key get seen --binding SEEN --remote`.

## Development

```bash
npm test        # unit tests (node:test)
npm run dev     # local Worker; GET /__scheduled triggers the cron handler
```

Local secrets go in `.dev.vars` (gitignored), e.g. `WEBHOOK_BASHBUNNI=https://discord.com/api/webhooks/...`.
