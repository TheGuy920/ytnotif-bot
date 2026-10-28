import test from 'node:test';
import assert from 'node:assert/strict';
import { health, ago, renderStatus } from '../src/status.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

test('health levels', () => {
    assert.equal(health({}, NOW).level, 'pending');
    assert.equal(health({ lastSubscribe: { at: hoursAgo(1), ok: true } }, NOW).level, 'ok');
    assert.equal(health({ lastSubscribe: { at: hoursAgo(1), ok: false, error: 'x' } }, NOW).label, 'Subscribe failed');
    assert.equal(health({ lastSubscribe: { at: hoursAgo(121), ok: true } }, NOW).label, 'Lease expired');
});

test('ago', () => {
    assert.equal(ago(hoursAgo(0), NOW), 'just now');
    assert.equal(ago(hoursAgo(3), NOW), '3 h ago');
    assert.equal(ago(hoursAgo(72), NOW), '3 days ago');
    assert.equal(ago('nope', NOW), 'unknown');
});

test('renders channels without leaking webhooks', async () => {
    const store = {
        channels: JSON.stringify([
            { channelId: 'UCa', name: '<b>A</b>', webhook: 'https://discord.com/api/webhooks/1/SECRET', filterShorts: true, lastSubscribe: { at: new Date().toISOString(), ok: true } },
            { channelId: 'UCb', name: 'B', webhook: 'WEBHOOK_B' },
        ]),
        'last:UCa': { title: 'Hello & bye', url: 'https://www.youtube.com/watch?v=x', postedAt: new Date().toISOString() },
    };
    const env = { STORE: { get: async (k, type) => store[k] ?? null } };
    const page = await renderStatus(env);
    assert.match(page, /&lt;b&gt;A&lt;\/b&gt;/);
    assert.match(page, /Hello &amp; bye/);
    assert.match(page, /1 of 2 subscriptions need attention/);
    assert.doesNotMatch(page, /SECRET|WEBHOOK_B|discord\.com/);
});
