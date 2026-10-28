import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, channelIdFromTopic, topicFor, subscriptionDetailsUrl } from '../src/hub.js';

test('verifies hub signatures', async () => {
    const body = new TextEncoder().encode('<feed/>');
    const good = 'sha1=' + createHmac('sha1', 's3cret').update(body).digest('hex');
    assert.equal(await verifySignature(body, good, 's3cret'), true);
    assert.equal(await verifySignature(body, good, 'other'), false);
    assert.equal(await verifySignature(body, null, 's3cret'), false);
    assert.equal(await verifySignature(body, 'sha256=abc', 's3cret'), false);
    assert.equal(await verifySignature(body, null, ''), true);
});

test('topic round-trip', () => {
    assert.equal(channelIdFromTopic(topicFor('UCabc')), 'UCabc');
    assert.equal(channelIdFromTopic('not a url'), null);
});

test('details URL carries the secret when set', () => {
    const url = new URL(subscriptionDetailsUrl({ channelId: 'UCabc', callbackUrl: 'https://x.dev/notifs', secret: 's3' }));
    assert.equal(url.searchParams.get('hub.topic'), topicFor('UCabc'));
    assert.equal(url.searchParams.get('hub.callback'), 'https://x.dev/notifs');
    assert.equal(url.searchParams.get('hub.secret'), 's3');
    assert.equal(new URL(subscriptionDetailsUrl({ channelId: 'UCabc', callbackUrl: 'https://x.dev/notifs' })).searchParams.has('hub.secret'), false);
});
