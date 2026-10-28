import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChannel, parseChannelId, publicChannel, webhookUrl } from '../src/channels.js';

const ID = 'UCabcdefghijklmnopqrstuv';
const HOOK = 'https://discord.com/api/webhooks/123456/abc-DEF_ghi';

test('parses channel IDs from IDs and URLs', () => {
    assert.equal(parseChannelId(ID), ID);
    assert.equal(parseChannelId(`https://www.youtube.com/channel/${ID}/videos`), ID);
    assert.equal(parseChannelId('@somechannel'), null);
    assert.equal(parseChannelId(undefined), null);
});

test('normalizes a new channel with defaults', () => {
    const c = normalizeChannel({ channelId: ID, webhook: HOOK });
    assert.deepEqual(c, {
        channelId: ID, name: ID, webhook: HOOK, filterShorts: true, announceUpdates: false, template: undefined,
    });
});

test('edits keep omitted fields', () => {
    const existing = { channelId: ID, name: 'bb', webhook: HOOK, filterShorts: false, announceUpdates: true, lastSubscribe: { ok: true } };
    const c = normalizeChannel({ name: '', template: '{"content":"hi"}' }, existing);
    assert.equal(c.name, 'bb');
    assert.equal(c.webhook, HOOK);
    assert.equal(c.filterShorts, false);
    assert.equal(c.announceUpdates, true);
    assert.deepEqual(c.template, { content: 'hi' });
    assert.deepEqual(c.lastSubscribe, { ok: true });
    assert.equal(normalizeChannel({ template: '' }, c).template, undefined);
});

test('rejects bad input', () => {
    assert.throws(() => normalizeChannel({ channelId: 'nope', webhook: HOOK }), /channelId/);
    assert.throws(() => normalizeChannel({ channelId: ID }), /webhook is required/);
    assert.throws(() => normalizeChannel({ channelId: ID, webhook: 'https://evil.example/x' }), /webhook must be/);
    assert.throws(() => normalizeChannel({ channelId: ID, webhook: HOOK, template: '{' }), /valid JSON/);
    assert.throws(() => normalizeChannel({ channelId: ID, webhook: HOOK, template: '[1]' }), /JSON object/);
});

test('resolves secret-name webhooks and masks URLs', () => {
    const bySecret = normalizeChannel({ channelId: ID, webhook: 'WEBHOOK_MAIN' });
    assert.equal(webhookUrl(bySecret, { WEBHOOK_MAIN: HOOK }), HOOK);
    assert.equal(webhookUrl(bySecret, {}), undefined);
    assert.equal(publicChannel(bySecret).webhook, 'WEBHOOK_MAIN');
    assert.equal(publicChannel(normalizeChannel({ channelId: ID, webhook: HOOK })).webhook, 'https://discord.com/api/webhooks/123456/••••••');
});
