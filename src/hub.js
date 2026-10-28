// PubSubHubbub (WebSub) helpers: subscribing and signature verification.

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

// Link to the hub's page for one subscription. A subscription made with a
// secret only shows its details when that secret is in the URL.
export function subscriptionDetailsUrl({ channelId, callbackUrl, secret }) {
    const params = new URLSearchParams({ 'hub.callback': callbackUrl, 'hub.topic': topicFor(channelId) });
    if (secret) params.set('hub.secret', secret);
    return `${DETAILS_URL}?${params}`;
}
