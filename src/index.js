import { loadChannels, webhookUrl, lastPostKey, TEMPLATE } from './channels.js';
import { renderStatus } from './status.js';
import { handleApi, renewSubscriptions } from './admin.js';
import { isFeed, parseFeed } from './feed.js';
import { SEEN_KEY, parseSeen, serializeSeen, seenKey, nowSec } from './seen.js';
import { render, sendDiscordMessage } from './discord.js';
import { verifySignature, channelIdFromTopic } from './hub.js';
import { isShort } from './shorts.js';
import ADMIN_HTML from './admin.html';

const NOTIFY_PATH = '/notifs';
const MAX_BODY_BYTES = 1024 * 1024;

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const path = normalizePath(url.pathname);

        // e.g. a Worker Preview whose "previews" block in wrangler.jsonc has no KV binding.
        if (!env.STORE) return text('No KV namespace is bound to this deployment.', 503);

        if (path === '/admin') return html(ADMIN_HTML, 'no-store');
        if (path.startsWith('/api/')) return handleApi(req, env, path);

        if (path === NOTIFY_PATH || path === callbackPath(env)) {
            if (req.method === 'GET') return handleVerification(url);
            if (req.method === 'POST') return handleNotification(req, env, ctx);
            return text('Method Not Allowed', 405, { Allow: 'GET, POST' });
        }

        // Everything else is the public status page.
        if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method Not Allowed', 405, { Allow: 'GET' });
        return html(await renderStatus(env), 'public, max-age=60');
    },

    // Hourly: renews hub subscriptions that are due (see `triggers.crons` in wrangler.jsonc).
    async scheduled(event, env, ctx) {
        if (env.STORE) await renewSubscriptions(env);
    },
};

function handleVerification(url) {
    const mode = url.searchParams.get('hub.mode');
    const challenge = url.searchParams.get('hub.challenge');
    const topic = url.searchParams.get('hub.topic');
    console.log(`[verify] hub.mode=${mode} hub.topic=${topic}`);

    if (!challenge || (mode !== 'subscribe' && mode !== 'unsubscribe')) {
        return text('Bad Request: missing/invalid hub.mode or hub.challenge', 400);
    }
    // We only send subscribe requests for tracked channels, and notifications
    // for anything else are ignored, so any YouTube topic can be confirmed.
    // (Checking the channel list here would race KV propagation right after
    // a channel is added.)
    if (!channelIdFromTopic(topic)) return text('Not Found', 404);
    return text(challenge);
}

async function handleNotification(req, env, ctx) {
    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return text('Payload Too Large', 413);

    // Per the WebSub spec a bad signature still gets a 2xx; we just drop it.
    if (!(await verifySignature(raw, req.headers.get('x-hub-signature'), env.HUB_SECRET))) {
        console.log('[notify] Signature verification failed, ignoring.');
        return new Response(null, { status: 204 });
    }

    const xml = new TextDecoder().decode(raw);
    if (!isFeed(xml)) {
        console.log('[notify] Not an Atom feed, ignoring:', xml.slice(0, 500));
        return new Response(null, { status: 204 });
    }

    // Ack the hub right away and finish the work in the background.
    ctx.waitUntil(
        processEntries(parseFeed(xml), env).catch((err) => console.error('[notify] Unhandled error:', err))
    );
    return new Response(null, { status: 204 });
}

async function processEntries(entries, env) {
    if (entries.length === 0) {
        console.log('[notify] No <entry> elements (probably a deletion); ignoring.');
        return;
    }

    const now = nowSec();
    const ttlDays = Number(env.SEEN_TTL_DAYS || 30);
    const [channels, seenText] = await Promise.all([loadChannels(env), env.STORE.get(SEEN_KEY)]);
    const seen = parseSeen(seenText, now);
    const added = new Map();

    for (const entry of entries) {
        const channel = channels.find((c) => c.channelId === entry.channelId);
        const tag = `[notify] [${channel?.name ?? entry.channelId}] ${entry.videoId}`;
        if (!channel) {
            console.log(`${tag} Skipping: channel not tracked.`);
            continue;
        }
        console.log(`${tag} "${entry.videoTitle}" published=${entry.publishedAt} updated=${entry.updatedAt}`);

        // Expire the seen line TTL after publishing. Anything published longer
        // ago than that is an edit ping on an old video, never a new upload.
        const published = Math.floor(Date.parse(entry.publishedAt) / 1000) || now;
        const expires = published + ttlDays * 86400;
        if (expires <= now) {
            console.log(`${tag} Skipping: published over ${ttlDays} days ago (edit ping).`);
            continue;
        }

        const key = seenKey(entry.channelId, entry.videoId);
        if ((seen.has(key) || added.has(key)) && !channel.announceUpdates) {
            console.log(`${tag} Skipping: already announced.`);
            continue;
        }

        if (channel.filterShorts ?? true) {
            const short = await isShort(entry.videoId, entry.videoUrl);
            if (short === true) {
                console.log(`${tag} Skipping: YouTube Short.`);
                added.set(key, expires);
                continue;
            }
            if (short === null) console.log(`${tag} Couldn't tell if it's a Short; allowing.`);
        }

        const url = webhookUrl(channel, env);
        if (!url) {
            console.error(`${tag} Secret ${channel.webhook} is not set; can't post.`);
            continue;
        }

        try {
            await sendDiscordMessage(url, render(channel.template ?? TEMPLATE, entry));
            console.log(`${tag} Posted to Discord.`);
            added.set(key, expires);
            await env.STORE.put(
                lastPostKey(entry.channelId),
                JSON.stringify({
                    videoId: entry.videoId,
                    title: entry.videoTitle,
                    url: entry.videoUrl,
                    publishedAt: entry.publishedAt,
                    postedAt: new Date().toISOString(),
                })
            ).catch((err) => console.error(`${tag} Couldn't record last post:`, err.message));
        } catch (err) {
            console.error(`${tag} Failed to post:`, err.message);
        }
    }

    if (added.size > 0) await saveSeen(env, added);
}

// Re-reads the list just before writing so a notification handled in
// parallel isn't clobbered, then merges our additions in.
async function saveSeen(env, added) {
    for (let attempt = 1; ; attempt++) {
        const current = parseSeen(await env.STORE.get(SEEN_KEY));
        for (const [key, expires] of added) current.set(key, expires);
        try {
            await env.STORE.put(SEEN_KEY, serializeSeen(current));
            return;
        } catch (err) {
            // KV allows ~1 write/sec per key; back off once and retry.
            if (attempt >= 2) throw err;
            await new Promise((r) => setTimeout(r, 1100));
        }
    }
}

function callbackPath(env) {
    try {
        return normalizePath(new URL(env.CALLBACK_URL).pathname);
    } catch {
        return NOTIFY_PATH;
    }
}

function normalizePath(p) {
    return p.replace(/\/+$/, '') || '/';
}

function html(body, cacheControl) {
    return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl } });
}

function text(body, status = 200, headers = {}) {
    return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });
}
