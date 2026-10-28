// PubSubHubbub (WebSub) helpers: subscribing and signature verification.

import { decode } from './feed.js';

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const DETAILS_URL = 'https://pubsubhubbub.appspot.com/subscription-details';
const LEASE_SECONDS = 432000; // 5 days, YouTube's max; the cron renews well before this

export const topicFor = (channelId) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;

export function channelIdFromTopic(topic) {
    try {
        return new URL(topic).searchParams.get('channel_id');
    } catch {
        return null;
    }
}

// Returns true if the hub accepted the request (202).
export async function subscribe({ channelId, callbackUrl, secret, mode = 'subscribe' }) {
    const body = new URLSearchParams({
        'hub.mode': mode,
        'hub.topic': topicFor(channelId),
        'hub.callback': callbackUrl,
        'hub.verify': 'async',
    });
    if (mode === 'subscribe') {
        body.set('hub.lease_seconds', String(LEASE_SECONDS));
        if (secret) body.set('hub.secret', secret);
    }

    const res = await fetch(HUB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (res.status === 202) return true;
    const text = await res.text().catch(() => '');
    throw new Error(`hub returned ${res.status}: ${text.trim()}`);
}

// Verifies `X-Hub-Signature: sha1=<hex>` against the raw body.
export async function verifySignature(rawBody, header, secret) {
    if (!secret) return true;
    const [algo, hex] = (header || '').split('=');
    if (algo !== 'sha1' || !/^[0-9a-f]{40}$/i.test(hex || '')) return false;

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['verify']
    );
    const sig = new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
    // subtle.verify compares in constant time.
    return crypto.subtle.verify('HMAC', key, sig, rawBody);
}

// Fetches the hub's subscription-details page as plain text. The hub only
// shows a subscription made with a secret to someone who supplies that
// secret, so this runs server-side rather than as a link in the browser.
export async function subscriptionDetails({ channelId, callbackUrl, secret }) {
    const params = new URLSearchParams({ 'hub.callback': callbackUrl, 'hub.topic': topicFor(channelId) });
    if (secret) params.set('hub.secret', secret);
    const res = await fetch(`${DETAILS_URL}?${params}`, { signal: AbortSignal.timeout(10000) });
    let text = htmlToText(await res.text());
    if (secret) text = text.replaceAll(secret, '••••••');
    return { status: res.status, text };
}

export function htmlToText(html) {
    return decode(
        html
            .replace(/<!--[\s\S]*?-->|<(head|script|style|textarea)[\s\S]*?<\/\1>/gi, '')
            .replace(/<\/t[hd]>/gi, '\t')
            .replace(/<(br|\/?(p|div|tr|li|dt|dd|h\d|table|ul|ol|dl))\b[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
    )
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}
