// Decides whether a video is a YouTube Short.
// Returns true (Short), false (regular video) or null (couldn't tell).
//
//   1. The feed's link: /shorts/<id> means Short, /watch?v= means not.
//      This is what decides it in practice; no network call needed.
//   2. oEmbed aspect ratio: portrait means Short.
//   3. HEAD /shorts/<id>: 200 means Short, a redirect away means not.
export async function isShort(videoId, videoUrl = '') {
    if (videoUrl.includes('youtube.com/shorts/')) return true;
    if (videoUrl.includes('youtube.com/watch')) return false;

    try {
        const res = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
            const { width, height } = await res.json();
            if (typeof width === 'number' && typeof height === 'number') return height > width;
        }
    } catch { }

    try {
        const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
        });
        return res.status === 200 || (res.headers.get('location') ?? '').includes('/shorts/');
    } catch { }

    return null;
}
