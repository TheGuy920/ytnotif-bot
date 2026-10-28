import { CHANNELS, TEMPLATE } from './config.js';
import { isFeed, parseFeed } from './feed.js';
import { SEEN_KEY, parseSeen, serializeSeen, seenKey, nowSec } from './seen.js';
import { render, sendDiscordMessage } from './discord.js';
import { subscribe, verifySignature, channelIdFromTopic } from './hub.js';
import { isShort } from './shorts.js';

const MAX_BODY_BYTES = 1024 * 1024;

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const path = normalizePath(url.pathname);

        if (path === '/resubscribe' && req.method === 'POST') {
            if (!env.ADMIN_TOKEN || req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
                return text('Forbidden', 403);
            }
            return text((await resubscribeAll(env)).join('\n') + '\n');
        }

        if (!callbackPaths(env).has(path)) return text('Not Found', 404);
        if (req.method === 'GET') return handleVerification(url);
        if (req.method === 'POST') return handleNotification(req, env, ctx);
        return text('Method Not Allowed', 405, { Allow: 'GET, POST' });
    },

    // Renews every channel's hub subscription (see `triggers.crons` in wrangler.jsonc).
    async scheduled(event, env, ctx) {
        for (const line of await resubscribeAll(env)) console.log(line);
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
    // Only confirm subscriptions for channels we still have configured, so
    // channels removed from config stop renewing.
    if (mode === 'subscribe' && !findChannel(channelIdFromTopic(topic))) {
        console.log(`[verify] Refusing subscribe for unconfigured topic ${topic}`);
        return text('Not Found', 404);
    }
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
    const ttl = Number(env.SEEN_TTL_DAYS || 30) * 86400;
    const seen = parseSeen(await env.SEEN.get(SEEN_KEY), now);
    const added = new Map();

    for (const entry of entries) {
        const channel = findChannel(entry.channelId);
        const tag = `[notify] [${channel?.name ?? entry.channelId}] ${entry.videoId}`;
        if (!channel) {
            console.log(`${tag} Skipping: channel not configured.`);
            continue;
        }
        console.log(`${tag} "${entry.videoTitle}" published=${entry.publishedAt} updated=${entry.updatedAt}`);

        // Expire the seen line TTL after publishing. Anything published longer
        // ago than that is an edit ping on an old video, never a new upload.
        const published = Math.floor(Date.parse(entry.publishedAt) / 1000) || now;
        const expires = published + ttl;
        if (expires <= now) {
            console.log(`${tag} Skipping: published over ${env.SEEN_TTL_DAYS || 30} days ago (edit ping).`);
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

        const webhookUrl = env[channel.webhook];
        if (!webhookUrl) {
            console.error(`${tag} Secret ${channel.webhook} is not set; can't post.`);
            continue;
        }

        try {
            await sendDiscordMessage(webhookUrl, render(channel.template ?? TEMPLATE, entry));
            console.log(`${tag} Posted to Discord.`);
            added.set(key, expires);
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
        const current = parseSeen(await env.SEEN.get(SEEN_KEY));
        for (const [key, expires] of added) current.set(key, expires);
        try {
            await env.SEEN.put(SEEN_KEY, serializeSeen(current));
            return;
        } catch (err) {
            // KV allows ~1 write/sec per key; back off once and retry.
            if (attempt >= 2) throw err;
            await new Promise((r) => setTimeout(r, 1100));
        }
    }
}

async function resubscribeAll(env) {
    const results = [];
    for (const channel of CHANNELS) {
        const callbackUrl = channel.callbackUrl || env.CALLBACK_URL;
        try {
            await subscribe({ channelId: channel.channelId, callbackUrl, secret: env.HUB_SECRET });
            results.push(`[subscribe] ${channel.name}: accepted (callback ${callbackUrl})`);
        } catch (err) {
            results.push(`[subscribe] ${channel.name}: FAILED ${err.message}`);
        }
    }
    return results;
}

function findChannel(channelId) {
    return channelId ? CHANNELS.find((c) => c.channelId === channelId) : undefined;
}

function callbackPaths(env) {
    const paths = new Set();
    for (const c of CHANNELS) {
        try {
            paths.add(normalizePath(new URL(c.callbackUrl || env.CALLBACK_URL).pathname));
        } catch { }
    }
    return paths;
}

function normalizePath(p) {
    return p.replace(/\/+$/, '') || '/';
}

function text(body, status = 200, headers = {}) {
    return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });
}
