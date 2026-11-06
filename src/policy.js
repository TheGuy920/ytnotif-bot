// Decides what to do with one notification entry for a tracked channel.
// Returns { post: true, expires } or { post: false, reason }.
//
//   publishedAt      the entry's <published> timestamp
//   updatedAt        the entry's <updated> timestamp
//   seen             whether this video is already in the seen list
//   announceUpdates  the channel's "re-post edits" setting
//   now              unix seconds
//   ttlDays          SEEN_TTL_DAYS
//   editGapMinutes   EDIT_GAP_MINUTES
export function classifyEntry({ publishedAt, updatedAt, seen, announceUpdates, now, ttlDays, editGapMinutes }) {
    const published = Math.floor(Date.parse(publishedAt) / 1000) || now;
    const expires = published + ttlDays * 86400;

    // Seen lines expire TTL after publishing, so anything older is an edit
    // ping on an old video, never a new upload.
    if (expires <= now) return { post: false, reason: `published over ${ttlDays} days ago (edit ping).` };

    if (seen) return announceUpdates ? { post: true, expires } : { post: false, reason: 'already announced.' };

    // Never announced here: an edit ping has <updated> well after <published>,
    // while a new upload's two timestamps are seconds apart (never exactly
    // equal: <updated> carries fractional seconds). Without a usable
    // <updated> there's nothing to compare, so treat it as new.
    const updated = Date.parse(updatedAt) / 1000;
    const gapMinutes = (updated - published) / 60;
    if (gapMinutes > editGapMinutes) {
        return {
            post: false,
            reason: `never announced here and updated ${formatGap(gapMinutes)} after publishing, so this is an edit ping, not a new upload.`,
        };
    }
    return { post: true, expires };
}

function formatGap(minutes) {
    if (minutes < 120) return `${Math.round(minutes)} min`;
    if (minutes < 2880) return `${Math.round(minutes / 60)} h`;
    return `${Math.round(minutes / 1440)} days`;
}
