import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntry } from '../src/policy.js';

const NOW = Date.parse('2026-11-06T20:44:23Z') / 1000;
const base = { now: NOW, ttlDays: 30, newWindowHours: 24, announceUpdates: false, seen: false };
const ago = (hours) => new Date((NOW - hours * 3600) * 1000).toISOString();

test('fresh upload posts and expires TTL after publishing', () => {
    const d = classifyEntry({ ...base, publishedAt: ago(0.1) });
    assert.equal(d.post, true);
    assert.equal(d.expires, Math.floor(NOW - 0.1 * 3600) + 30 * 86400);
});

test('edit ping on a video published before tracking is skipped', () => {
    // Real case: published 2026-10-23, never announced here, title edited 2026-11-06.
    const d = classifyEntry({ ...base, publishedAt: '2026-10-23T12:00:25+00:00' });
    assert.equal(d.post, false);
    assert.match(d.reason, /never announced here/);
});

test('re-post edits does not post never-announced old videos either', () => {
    assert.equal(classifyEntry({ ...base, announceUpdates: true, publishedAt: ago(48) }).post, false);
});

test('already announced: skipped unless re-post edits is on', () => {
    assert.equal(classifyEntry({ ...base, seen: true, publishedAt: ago(48) }).post, false);
    assert.equal(classifyEntry({ ...base, seen: true, announceUpdates: true, publishedAt: ago(48) }).post, true);
});

test('older than the seen TTL is always skipped', () => {
    const d = classifyEntry({ ...base, seen: true, announceUpdates: true, publishedAt: ago(31 * 24) });
    assert.equal(d.post, false);
    assert.match(d.reason, /over 30 days/);
});

test('window is configurable and unparseable dates count as now', () => {
    assert.equal(classifyEntry({ ...base, newWindowHours: 72, publishedAt: ago(48) }).post, true);
    assert.equal(classifyEntry({ ...base, publishedAt: 'garbage' }).post, true);
});
