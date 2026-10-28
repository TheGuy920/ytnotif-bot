// "Already announced" list, stored as ONE plain-text KV value:
//
//   channelId:videoId:expiresAtUnixSeconds\n
//
// One key means one KV read per notification and one write only when
// something changed, which sits comfortably inside KV's free tier.
// Expired lines are dropped whenever the list is rewritten.

export const SEEN_KEY = 'seen';

export function parseSeen(text, now = nowSec()) {
    const map = new Map();
    for (const line of (text || '').split('\n')) {
        // channel IDs and video IDs never contain ':', so split from the right.
        const i = line.lastIndexOf(':');
        const j = line.lastIndexOf(':', i - 1);
        if (i < 0 || j < 0) continue;
        const expires = Number(line.slice(i + 1));
        if (!(expires > now)) continue;
        map.set(line.slice(0, i), expires);
    }
    return map;
}

export function serializeSeen(map, now = nowSec()) {
    let out = '';
    for (const [key, expires] of map) {
        if (expires > now) out += `${key}:${expires}\n`;
    }
    return out;
}

export const seenKey = (channelId, videoId) => `${channelId}:${videoId}`;

export function nowSec() {
    return Math.floor(Date.now() / 1000);
}
