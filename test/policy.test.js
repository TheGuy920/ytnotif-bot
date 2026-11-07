import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntry } from '../src/policy.js';

const NOW = Date.parse('2026-11-06T20:44:23Z') / 1000;
const base = { now: NOW, ttlDays: 30, editGapMinutes: 60, announceUpdates: false, seen: false };
const iso = (unix) => new Date(unix * 1000).toISOString();

test('fresh upload (updated seconds after published) posts', () => {
    const published = NOW - 30;
    const d = classifyEntry({ ...base, publishedAt: iso(published), updatedAt: '2026-11-06T20:44:02.123456789+00:00' });
    assert.equal(d.post, true);
    assert.equal(d.expires, published + 30 * 86400);
});

test('edit ping on a never-announced video is skipped', () => {
    // Real case: published 2026-10-23, title edited 2026-11-06.
    const d = classifyEntry({
        ...base,
        publishedAt: '2026-10-23T12:00:25+00:00',
        updatedAt: '2026-11-06T20:44:22.241024484+00:00',
    });
    assert.equal(d.post, false);
    assert.match(d.reason, /updated 14 days after publishing/);
});

test('re-post edits does not post never-announced edited videos either', () => {
    const d = classifyEntry({ ...base, announceUpdates: true, publishedAt: iso(NOW - 2 * 3600), updatedAt: iso(NOW) });
    assert.equal(d.post, false);
});

test('already announced: skipped unless re-post edits is on', () => {
    const entry = { publishedAt: iso(NOW - 3600), updatedAt: iso(NOW) };
    assert.equal(classifyEntry({ ...base, ...entry, seen: true }).post, false);
    assert.equal(classifyEntry({ ...base, ...entry, seen: true, announceUpdates: true }).post, true);
});

test('older than the seen TTL is always skipped', () => {
    const d = classifyEntry({ ...base, seen: true, announceUpdates: true, publishedAt: iso(NOW - 31 * 86400), updatedAt: iso(NOW) });
    assert.equal(d.post, false);
    assert.match(d.reason, /over 30 days/);
});

test('gap is configurable; missing or unparseable timestamps count as new', () => {
    const entry = { publishedAt: iso(NOW - 90 * 60), updatedAt: iso(NOW) }; // 90 min gap
    assert.equal(classifyEntry({ ...base, ...entry }).post, false);
    assert.equal(classifyEntry({ ...base, ...entry, editGapMinutes: 120 }).post, true);
    // 45 min gap is still a new upload under the 60 min default.
    assert.equal(classifyEntry({ ...base, publishedAt: iso(NOW - 45 * 60), updatedAt: iso(NOW) }).post, true);
    assert.equal(classifyEntry({ ...base, publishedAt: iso(NOW - 60), updatedAt: '' }).post, true);
    assert.equal(classifyEntry({ ...base, publishedAt: 'garbage', updatedAt: 'garbage' }).post, true);
});
