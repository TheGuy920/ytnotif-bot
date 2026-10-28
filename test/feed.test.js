import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFeed, parseFeed } from '../src/feed.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parses a fresh upload notification', () => {
    const [e, ...rest] = parseFeed(fixture('new-video.xml'));
    assert.equal(rest.length, 0);
    assert.equal(e.videoId, 'dQw4w9WgXcQ');
    assert.equal(e.videoUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(e.videoTitle, 'My Awesome New Video');
    assert.equal(e.channelId, 'UCabc123CHANNELID');
    assert.equal(e.channelName, 'Cool Channel');
    assert.equal(e.channelUrl, 'https://www.youtube.com/channel/UCabc123CHANNELID');
    assert.equal(e.publishedAt, '2026-06-28T19:59:30+00:00');
});

test('parses an edit notification', () => {
    const [e] = parseFeed(fixture('edited-video.xml'));
    assert.equal(e.videoTitle, 'My Awesome New Video (edited title)');
    assert.equal(e.updatedAt, '2026-06-28T22:15:00+00:00');
});

test('decodes entities and keeps the Shorts link', () => {
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
      <title>YouTube video feed</title>
      <entry>
        <id>yt:video:abc_-123XYZ</id>
        <yt:videoId>abc_-123XYZ</yt:videoId>
        <yt:channelId>UCxyz</yt:channelId>
        <title>Tom &amp; Jerry &#39;quoted&#39; &lt;3 &#x1F600;</title>
        <link rel="alternate" href="https://www.youtube.com/shorts/abc_-123XYZ"/>
        <author><name>A &amp; B</name><uri>https://www.youtube.com/channel/UCxyz</uri></author>
        <published>2026-06-28T19:59:30+00:00</published>
        <updated>2026-06-28T20:00:00+00:00</updated>
      </entry></feed>`;
    const [e] = parseFeed(xml);
    assert.equal(e.videoTitle, "Tom & Jerry 'quoted' <3 😀");
    assert.equal(e.channelName, 'A & B');
    assert.equal(e.videoUrl, 'https://www.youtube.com/shorts/abc_-123XYZ');
});

test('deletion notifications yield no entries', () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
      <feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
        <at:deleted-entry ref="yt:video:dQw4w9WgXcQ" when="2026-06-28T20:00:00+00:00">
          <link href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
        </at:deleted-entry>
      </feed>`;
    assert.ok(isFeed(xml));
    assert.deepEqual(parseFeed(xml), []);
});

test('isFeed rejects non-feeds', () => {
    assert.equal(isFeed('hello'), false);
    assert.equal(isFeed('<html><body></body></html>'), false);
});
