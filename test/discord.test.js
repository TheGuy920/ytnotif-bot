import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/discord.js';

test('substitutes placeholders across nested structures', () => {
    const out = render(
        { content: 'New: {{ videoTitle }}', embeds: [{ title: '{{videoTitle}}', url: '{{videoUrl}}', color: 123 }] },
        { videoTitle: 'Hello', videoUrl: 'https://youtu.be/abc' }
    );
    assert.deepEqual(out, { content: 'New: Hello', embeds: [{ title: 'Hello', url: 'https://youtu.be/abc', color: 123 }] });
});

test('leaves unknown placeholders untouched', () => {
    assert.equal(render('{{nope}}', {}), '{{nope}}');
});
