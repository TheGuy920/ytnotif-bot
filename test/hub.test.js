import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, channelIdFromTopic, topicFor } from '../src/hub.js';

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

test('htmlToText flattens the hub details page', async () => {
    const { htmlToText } = await import('../src/hub.js');
    const html = `<html><head><title>x</title><style>td{}</style></head><body>
      <h1>Subscription details</h1>
      <form><input name="hub.secret" value="s3cret"></form>
      <table><tr><td>State</td><td>verified</td></tr>
      <tr><td>Expiration time</td><td>2026-11-02 &amp; later</td></tr></table></body></html>`;
    assert.equal(htmlToText(html), 'Subscription details\nState verified\nExpiration time 2026-11-02 & later');
});
