// Tracked channels, stored as JSON in KV (key `channels`) so they can be
// added and removed at runtime through the admin API / page.
//
// Record shape:
//   channelId        YouTube channel ID (UC...)
//   name             label for logs and the admin page
//   webhook          Discord webhook URL, or the NAME of a Worker secret
//                    holding one (keeps the URL out of KV)
//   filterShorts     skip Shorts (default true)
//   announceUpdates  re-post when YouTube pings an announced video again
//   template         optional Discord payload; defaults to TEMPLATE
//   callbackUrl      URL the hub was told to call for this channel
//   lastSubscribe    { at, ok, error? } result of the last hub request

export const CHANNELS_KEY = 'channels';

// Per-channel key holding the last video posted to Discord, for the status
// page. Kept separate from `channels` so posting never rewrites the list.
export const lastPostKey = (channelId) => `last:${channelId}`;

export const TEMPLATE = {
    content: '**{{channelName}}** just uploaded!\n{{videoUrl}}',
};

const CHANNEL_ID_RE = /UC[\w-]{22}/;
const WEBHOOK_URL_RE = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export async function loadChannels(env) {
    try {
        const list = JSON.parse((await env.STORE.get(CHANNELS_KEY)) || '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        console.error('[channels] Stored channel list is not valid JSON; treating as empty.');
        return [];
    }
}

export function saveChannels(env, channels) {
    return env.STORE.put(CHANNELS_KEY, JSON.stringify(channels));
}

// Pulls a channel ID out of a raw ID or any youtube.com/channel/UC... URL.
export function parseChannelId(input) {
    return String(input ?? '').match(CHANNEL_ID_RE)?.[0] ?? null;
}

// Validates admin input and merges it over `existing` (for edits, where
// omitted fields keep their old value). Throws Error with a user-facing
// message on bad input.
export function normalizeChannel(input, existing = {}) {
    const channelId = parseChannelId(input.channelId) ?? existing.channelId;
    if (!channelId) throw new Error('channelId must be a YouTube channel ID (UC…) or channel URL');

    const webhook = String(input.webhook ?? '').trim() || existing.webhook;
    if (!webhook) throw new Error('webhook is required (Discord webhook URL or secret name)');
    if (!WEBHOOK_URL_RE.test(webhook) && !SECRET_NAME_RE.test(webhook)) {
        throw new Error('webhook must be a Discord webhook URL or an UPPER_CASE secret name');
    }

    let template = input.template === undefined ? existing.template : input.template;
    if (typeof template === 'string') {
        if (!template.trim()) template = undefined;
        else {
            try {
                template = JSON.parse(template);
            } catch {
                throw new Error('template must be valid JSON');
            }
        }
    }
    if (template != null && (typeof template !== 'object' || Array.isArray(template))) {
        throw new Error('template must be a JSON object (a Discord webhook payload)');
    }

    return {
        ...existing,
        channelId,
        name: String(input.name ?? '').trim() || existing.name || channelId,
        webhook,
        filterShorts: bool(input.filterShorts, existing.filterShorts ?? true),
        announceUpdates: bool(input.announceUpdates, existing.announceUpdates ?? false),
        template: template ?? undefined,
    };
}

// Resolves a channel's webhook field to an actual URL.
export function webhookUrl(channel, env) {
    return WEBHOOK_URL_RE.test(channel.webhook) ? channel.webhook : env[channel.webhook];
}

// Copy safe to return from the API: hides the webhook token.
export function publicChannel(channel) {
    const masked = WEBHOOK_URL_RE.test(channel.webhook)
        ? channel.webhook.replace(/\/[\w-]+$/, '/••••••')
        : channel.webhook;
    return { ...channel, webhook: masked };
}

function bool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || value === 'true' || value === 'on' || value === 1;
}
