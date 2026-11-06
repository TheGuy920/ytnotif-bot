// Decides what to do with one notification entry for a tracked channel.
// Returns { post: true, expires } or { post: false, reason }.
//
//   publishedAt      the entry's <published> timestamp
//   seen             whether this video is already in the seen list
//   announceUpdates  the channel's "re-post edits" setting
//   now              unix seconds
//   ttlDays          SEEN_TTL_DAYS
//   newWindowHours   NEW_VIDEO_WINDOW_HOURS
export function classifyEntry({ publishedAt, seen, announceUpdates, now, ttlDays, newWindowHours }) {
    const published = Math.floor(Date.parse(publishedAt) / 1000) || now;
    const expires = published + ttlDays * 86400;

    // Seen lines expire TTL after publishing, so anything older is an edit
    // ping on an old video, never a new upload.
    if (expires <= now) return { post: false, reason: `published over ${ttlDays} days ago (edit ping).` };

    if (seen) return announceUpdates ? { post: true, expires } : { post: false, reason: 'already announced.' };

    // Never announced here. A real upload is pinged within minutes of being
    // published, so an older video is an edit ping on something published
    // before this Worker tracked the channel.
    const ageHours = (now - published) / 3600;
    if (ageHours > newWindowHours) {
        return {
            post: false,
            reason: `never announced here and published ${Math.round(ageHours)} h ago, so this is an edit ping, not a new upload.`,
        };
    }
    return { post: true, expires };
}
