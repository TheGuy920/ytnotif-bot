import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeen, serializeSeen, seenKey } from '../src/seen.js';

test('round-trips and drops expired lines', () => {
    const text = 'UCa:vid1:2000\nUCa:vid2:500\nUCb:a-b_c:3000\n\ngarbage\n';
    const map = parseSeen(text, 1000);
    assert.deepEqual([...map.keys()], ['UCa:vid1', 'UCb:a-b_c']);
    assert.ok(map.has(seenKey('UCb', 'a-b_c')));
    assert.equal(serializeSeen(map, 1000), 'UCa:vid1:2000\nUCb:a-b_c:3000\n');
    assert.equal(serializeSeen(map, 2500), 'UCb:a-b_c:3000\n');
});

test('handles an empty/missing value', () => {
    assert.equal(parseSeen(null).size, 0);
    assert.equal(serializeSeen(new Map()), '');
});
