// Admin JSON API for managing tracked channels at runtime.
// Every route needs `Authorization: Bearer <ADMIN_TOKEN>`.

import {
    loadChannels,
    saveChannels,
    normalizeChannel,
    parseChannelId,
    publicChannel,
    webhookUrl,
    TEMPLATE,
} from './channels.js';
import { subscribe, subscriptionDetails } from './hub.js';
import { render, sendDiscordMessage } from './discord.js';

// Renewal policy for the hourly cron. The free plan allows 50 outbound
// requests per invocation, so renewals are spread across runs.
const RENEW_AFTER_SEC = 24 * 3600;
const RETRY_FAILED_AFTER_SEC = 3600;
const MAX_RENEWALS_PER_RUN = 40;

export async function handleApi(req, env, path) {
    if (!env.ADMIN_TOKEN) return json({ error: 'Set the ADMIN_TOKEN secret to enable the admin API.' }, 503);
    if (!(await authorized(req, env))) return json({ error: 'Unauthorized' }, 401);

    const origin = new URL(req.url).origin;
    const [, , resource, id, action] = path.split('/'); // /api/<resource>/<id>/<action>

    try {
        if (resource === 'channels' && !id) {
            if (req.method === 'GET') return await listChannels(env, origin);
            if (req.method === 'PUT') return await replaceChannels(req, env, origin);
        }
        if (resource === 'channels' && id && !action) {
            if (req.method === 'PUT') return await upsertChannel(req, env, origin, id);
            if (req.method === 'DELETE') return await deleteChannel(env, id);
        }
        if (resource === 'channels' && id && action === 'test' && req.method === 'POST') {
            return await testChannel(env, id);
        }
        if (resource === 'channels' && id && action === 'hub' && req.method === 'GET') {
            return await hubDetails(env, id);
        }
        if (resource === 'resubscribe' && req.method === 'POST') {
            return json({ channels: (await renewSubscriptions(env, { force: true, origin })).map(publicChannel) });
        }
        return json({ error: 'Not Found' }, 404);
    } catch (err) {
        if (err instanceof UserError) return json({ error: err.message }, 400);
        console.error('[admin] Unhandled error:', err);
        return json({ error: 'Internal error: ' + err.message }, 500);
    }
}

async function listChannels(env, origin) {
    const channels = await loadChannels(env);
    return json({ callbackUrl: callbackUrlFor(env, origin), channels: channels.map(publicChannel) });
}

async function upsertChannel(req, env, origin, rawId) {
    const id = parseChannelId(decodeURIComponent(rawId));
    if (!id) throw new UserError('Not a valid YouTube channel ID');
    const body = await readJson(req);

    const channels = await loadChannels(env);
    const index = channels.findIndex((c) => c.channelId === id);
    const existing = channels[index];

    const channel = check(() => normalizeChannel({ ...body, channelId: id }, existing));
    if (channel.webhook !== existing?.webhook) await validateWebhook(channel, env);
    if (channel.name === channel.channelId) channel.name = (await lookupChannelName(id)) ?? id;

    await subscribeChannel(channel, env, origin);

    if (index >= 0) channels[index] = channel;
    else channels.push(channel);
    await saveChannels(env, channels);
    console.log(`[admin] ${existing ? 'Updated' : 'Added'} channel ${channel.name} (${id})`);
    return json({ channel: publicChannel(channel) }, existing ? 200 : 201);
}

async function deleteChannel(env, rawId) {
    const id = parseChannelId(decodeURIComponent(rawId));
    const channels = await loadChannels(env);
    const channel = channels.find((c) => c.channelId === id);
    if (!channel) return json({ error: 'Channel not found' }, 404);

    await saveChannels(env, channels.filter((c) => c !== channel));
    let unsubscribed = true;
    try {
        if (channel.callbackUrl) await subscribe({ channelId: id, callbackUrl: channel.callbackUrl, mode: 'unsubscribe' });
    } catch (err) {
        // Not fatal: the lease lapses within 5 days and notifications for
        // unlisted channels are ignored anyway.
        console.error(`[admin] Unsubscribe for ${channel.name} failed:`, err.message);
        unsubscribed = false;
    }
    console.log(`[admin] Removed channel ${channel.name} (${id})`);
    return json({ removed: id, unsubscribed });
}

// Replaces the whole list in one go (handy for imports). Channels missing
// from the new list are unsubscribed.
async function replaceChannels(req, env, origin) {
    const body = await readJson(req);
    const input = Array.isArray(body) ? body : body.channels;
    if (!Array.isArray(input)) throw new UserError('Body must be a JSON array of channels');

    const old = await loadChannels(env);
    const byId = new Map(old.map((c) => [c.channelId, c]));
    const next = [];
    for (const [i, item] of input.entries()) {
        const existing = byId.get(parseChannelId(item.channelId));
        const channel = check(() => normalizeChannel(item, existing), `channel #${i + 1}`);
        if (next.some((c) => c.channelId === channel.channelId)) {
            throw new UserError(`channel #${i + 1}: duplicate channelId ${channel.channelId}`);
        }
        if (channel.webhook !== existing?.webhook) await validateWebhook(channel, env, `channel #${i + 1}`);
        next.push(channel);
    }

    for (const channel of next) {
        if (!byId.has(channel.channelId)) await subscribeChannel(channel, env, origin);
    }
    for (const channel of old) {
        if (!next.some((c) => c.channelId === channel.channelId) && channel.callbackUrl) {
            await subscribe({ channelId: channel.channelId, callbackUrl: channel.callbackUrl, mode: 'unsubscribe' }).catch(
                (err) => console.error(`[admin] Unsubscribe for ${channel.name} failed:`, err.message)
            );
        }
    }

    await saveChannels(env, next);
    console.log(`[admin] Replaced channel list (${next.length} channels)`);
    return json({ channels: next.map(publicChannel) });
}

async function testChannel(env, rawId) {
    const id = parseChannelId(decodeURIComponent(rawId));
    const channel = (await loadChannels(env)).find((c) => c.channelId === id);
    if (!channel) return json({ error: 'Channel not found' }, 404);
    const url = webhookUrl(channel, env);
    if (!url) throw new UserError(`Secret ${channel.webhook} is not set`);

    const now = new Date().toISOString();
    const sample = {
        videoId: 'dQw4w9WgXcQ',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        videoTitle: 'Test notification from ytnotif-bot',
        channelId: id,
        channelName: channel.name,
        channelUrl: `https://www.youtube.com/channel/${id}`,
        publishedAt: now,
        updatedAt: now,
    };
    try {
        await sendDiscordMessage(url, render(channel.template ?? TEMPLATE, sample));
    } catch (err) {
        throw new UserError(err.message);
    }
    return json({ sent: true });
}

async function hubDetails(env, rawId) {
    const id = parseChannelId(decodeURIComponent(rawId));
    const channel = (await loadChannels(env)).find((c) => c.channelId === id);
    if (!channel) return json({ error: 'Channel not found' }, 404);
    if (!channel.callbackUrl) throw new UserError('Not subscribed yet');
    try {
        return json(await subscriptionDetails({ channelId: id, callbackUrl: channel.callbackUrl, secret: env.HUB_SECRET }));
    } catch (err) {
        throw new UserError(`Couldn't reach the hub: ${err.message}`);
    }
}

// Called by the cron (only channels due for renewal) and by
// POST /api/resubscribe (force: everything). Returns the updated list.
export async function renewSubscriptions(env, { force = false, origin } = {}) {
    const channels = await loadChannels(env);
    const now = Date.now() / 1000;
    const due = channels
        .filter((c) => {
            if (force || !c.lastSubscribe) return true;
            const age = now - Date.parse(c.lastSubscribe.at) / 1000;
            return age > (c.lastSubscribe.ok ? RENEW_AFTER_SEC : RETRY_FAILED_AFTER_SEC);
        })
        .slice(0, MAX_RENEWALS_PER_RUN);

    for (const channel of due) await subscribeChannel(channel, env, origin);
    if (due.length > 0) await saveChannels(env, channels);
    return channels;
}

// Sends a subscribe request and records the outcome on the channel.
async function subscribeChannel(channel, env, origin) {
    const callbackUrl = callbackUrlFor(env, origin) ?? channel.callbackUrl;
    if (!callbackUrl) {
        channel.lastSubscribe = { at: new Date().toISOString(), ok: false, error: 'No callback URL known yet' };
        return;
    }
    if (channel.callbackUrl && channel.callbackUrl !== callbackUrl) {
        // Moving hosts: drop the old subscription so pings don't arrive twice.
        await subscribe({ channelId: channel.channelId, callbackUrl: channel.callbackUrl, mode: 'unsubscribe' }).catch(
            (err) => console.error(`[subscribe] ${channel.name}: unsubscribing old callback failed: ${err.message}`)
        );
    }
    channel.callbackUrl = callbackUrl;
    try {
        await subscribe({ channelId: channel.channelId, callbackUrl, secret: env.HUB_SECRET });
        channel.lastSubscribe = { at: new Date().toISOString(), ok: true };
        console.log(`[subscribe] ${channel.name}: accepted (callback ${callbackUrl})`);
    } catch (err) {
        channel.lastSubscribe = { at: new Date().toISOString(), ok: false, error: err.message };
        console.error(`[subscribe] ${channel.name}: FAILED ${err.message}`);
    }
}

// CALLBACK_URL wins; otherwise the hub calls back to whatever host the
// admin request came in on. The cron has no request, so it reuses the URL
// stored on each channel.
function callbackUrlFor(env, origin) {
    if (env.CALLBACK_URL) return env.CALLBACK_URL;
    return origin ? `${origin}/notifs` : undefined;
}

async function validateWebhook(channel, env, label) {
    const prefix = label ? `${label}: ` : '';
    const url = webhookUrl(channel, env);
    if (!url) throw new UserError(`${prefix}Secret ${channel.webhook} is not set (npx wrangler secret put ${channel.webhook})`);
    // A GET on a webhook URL returns its details if the token is valid.
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) throw new UserError(`${prefix}Discord rejected the webhook URL (${res?.status ?? 'network error'})`);
}

// Best-effort: reads the channel's display name from its public feed.
async function lookupChannelName(channelId) {
    try {
        const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const xml = await res.text();
        return xml.match(/<author>\s*<name>([^<]+)<\/name>/)?.[1]?.trim() ?? null;
    } catch {
        return null;
    }
}

async function authorized(req, env) {
    const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const digest = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    const [a, b] = await Promise.all([digest(given), digest(env.ADMIN_TOKEN)]);
    return crypto.subtle.timingSafeEqual(a, b);
}

async function readJson(req) {
    try {
        return await req.json();
    } catch {
        throw new UserError('Body must be JSON');
    }
}

function check(fn, label) {
    try {
        return fn();
    } catch (err) {
        throw new UserError(label ? `${label}: ${err.message}` : err.message);
    }
}

class UserError extends Error { }

export function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
