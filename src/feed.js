// Minimal parser for YouTube's PubSubHubbub Atom payloads. The format is
// small and fixed, so a few regexes beat bundling an XML library (and keep
// us well inside the free plan's CPU budget).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
            if (e[0] === '#') {
                const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : m;
            }
            return ENTITIES[e.toLowerCase()] ?? m;
        })
        .trim();
}

// Text content of the first <tag> (namespace prefix optional), or undefined.
function tag(xml, name) {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
    return m ? decode(m[1]) : undefined;
}

export function isFeed(xml) {
    return /<(?:\w+:)?feed[\s>]/.test(xml);
}

// Returns one normalized object per <entry>. Deletions arrive as
// <at:deleted-entry> and are intentionally not matched.
export function parseFeed(xml) {
    const entries = [];
    for (const [, body] of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
        const videoId = tag(body, 'videoId') ?? tag(body, 'id')?.split(':').pop();
        if (!videoId) continue;

        const author = tag(body, 'author') ?? '';
        const authorUri = tag(author, 'uri');
        const channelId = tag(body, 'channelId') ?? authorUri?.match(/channel\/([\w-]+)/)?.[1];

        // Shorts arrive as youtube.com/shorts/<id>, regular videos as /watch?v=<id>.
        const href = body.match(/<link[^>]*\bhref="([^"]+)"/)?.[1];
        const videoUrl = href?.startsWith('http') ? decode(href) : `https://www.youtube.com/watch?v=${videoId}`;

        entries.push({
            videoId,
            videoUrl,
            videoTitle: tag(body, 'title') ?? '(untitled)',
            channelId,
            channelName: tag(author, 'name') ?? '(unknown channel)',
            channelUrl: authorUri ?? (channelId ? `https://www.youtube.com/channel/${channelId}` : ''),
            publishedAt: tag(body, 'published') ?? '',
            updatedAt: tag(body, 'updated') ?? '',
        });
    }
    return entries;
}
