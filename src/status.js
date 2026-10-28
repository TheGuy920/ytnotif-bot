// Public status page: tracked channels, subscription health, last post.
// Server-rendered and read-only; never includes webhooks or secrets.

import { loadChannels, lastPostKey } from './channels.js';

const LEASE_SEC = 432000; // matches hub.js

export async function renderStatus(env) {
    const channels = await loadChannels(env);
    const lastPosts = await Promise.all(
        channels.map((c) => env.STORE.get(lastPostKey(c.channelId), 'json').catch(() => null))
    );
    const now = Date.now();
    const rows = channels.map((c, i) => ({ channel: c, health: health(c, now), last: lastPosts[i] }));
    const healthy = rows.filter((r) => r.health.level === 'ok').length;

    const summary =
        rows.length === 0
            ? 'No channels tracked yet.'
            : healthy === rows.length
                ? `All ${rows.length} subscription${rows.length === 1 ? '' : 's'} healthy`
                : `${rows.length - healthy} of ${rows.length} subscription${rows.length === 1 ? '' : 's'} need attention`;
    const summaryLevel = rows.length === 0 ? 'muted' : healthy === rows.length ? 'ok' : 'bad';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>ytnotif-bot status</title>
<style>${CSS}</style>
</head>
<body>
<main>
    <header>
        <h1>ytnotif-bot</h1>
        <a class="muted" href="/admin">admin</a>
    </header>
    <p class="summary ${summaryLevel}">${esc(summary)}</p>
    <section class="card">
        ${rows.map(renderRow).join('') || '<p class="muted">Add channels from the admin page.</p>'}
    </section>
    <p class="muted foot">Updated ${esc(new Date(now).toUTCString())} · refreshes every 5 minutes</p>
</main>
</body>
</html>`;
}

function renderRow({ channel: c, health: h, last }) {
    const lastLine = last
        ? `Last post: <a href="${esc(last.url)}" target="_blank" rel="noopener">${esc(last.title)}</a>
           <span class="muted" title="${esc(last.postedAt)}">· ${esc(ago(last.postedAt))}</span>`
        : '<span class="muted">No posts yet</span>';
    return `<div class="row">
        <div class="info">
            <a class="name" href="https://www.youtube.com/channel/${esc(c.channelId)}" target="_blank" rel="noopener">${esc(c.name)}</a>
            <div class="chips">
                <span class="chip">${c.filterShorts ? 'skips Shorts' : 'posts Shorts'}</span>
                ${c.announceUpdates ? '<span class="chip">re-posts edits</span>' : ''}
            </div>
            <div class="last">${lastLine}</div>
        </div>
        <div class="status ${h.level}" title="${esc(h.title)}">${esc(h.label)}</div>
    </div>`;
}

// ok: hub accepted the last subscribe and its lease is still running.
export function health(channel, now = Date.now()) {
    const sub = channel.lastSubscribe;
    if (!sub) return { level: 'pending', label: 'Pending', title: 'Not subscribed yet' };
    const at = Date.parse(sub.at);
    if (!sub.ok) {
        return { level: 'bad', label: 'Subscribe failed', title: `${sub.error || 'Hub request failed'} (${ago(sub.at, now)})` };
    }
    if (now - at > LEASE_SEC * 1000) {
        return { level: 'bad', label: 'Lease expired', title: `Last renewed ${ago(sub.at, now)}` };
    }
    return { level: 'ok', label: '✓ Subscribed', title: `Renewed ${ago(sub.at, now)}` };
}

export function ago(iso, now = Date.now()) {
    const s = (now - Date.parse(iso)) / 1000;
    if (!Number.isFinite(s)) return 'unknown';
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CSS = `
    :root {
        --bg: #f6f7f9; --card: #fff; --text: #1b1d21; --muted: #6b7280; --border: #e3e5e9;
        --ok: #15803d; --ok-bg: #dcfce7; --bad: #b91c1c; --bad-bg: #fee2e2; --pend: #92400e; --pend-bg: #fef3c7; --chip: #eef0f3;
    }
    @media (prefers-color-scheme: dark) {
        :root {
            --bg: #111317; --card: #1a1d22; --text: #e8eaed; --muted: #9aa0a8; --border: #2b2f36;
            --ok: #4ade80; --ok-bg: #12301d; --bad: #f87171; --bad-bg: #3a1616; --pend: #fbbf24; --pend-bg: #3a2c0c; --chip: #252930;
        }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    h1 { font-size: 22px; margin: 0; }
    a { color: inherit; }
    .muted { color: var(--muted); font-size: 13px; }
    .summary { font-weight: 600; margin: 16px 0; }
    .summary.ok { color: var(--ok); } .summary.bad { color: var(--bad); }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 4px 16px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 0; border-top: 1px solid var(--border); }
    .row:first-child { border-top: 0; }
    .info { min-width: 0; flex: 1; }
    .name { font-weight: 600; text-decoration: none; }
    .name:hover { text-decoration: underline; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
    .chip { background: var(--chip); border-radius: 99px; padding: 1px 8px; font-size: 12px; }
    .last { font-size: 14px; overflow-wrap: anywhere; }
    .status { flex: 0 0 auto; font-size: 13px; font-weight: 600; padding: 2px 10px; border-radius: 99px; white-space: nowrap; }
    .status.ok { color: var(--ok); background: var(--ok-bg); }
    .status.bad { color: var(--bad); background: var(--bad-bg); }
    .status.pending { color: var(--pend); background: var(--pend-bg); }
    .foot { margin-top: 16px; }
`;
