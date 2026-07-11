import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, makeSource } from './helpers.js';
import * as youtube from '../src/channels/youtube.js';
import * as x from '../src/channels/x.js';
import { prepareSource } from '../src/core/fetchSource.js';

test('youtube.detect：channel链接 / @handle链接 / 裸UC均可识别', () => {
  assert.deepEqual(youtube.detect('https://www.youtube.com/channel/UCabcdefghijklmnop12345'),
    { identifier: 'UCabcdefghijklmnop12345' });
  assert.deepEqual(youtube.detect('https://www.youtube.com/@xiaojunpodcast'),
    { identifier: '@xiaojunpodcast' });
  assert.deepEqual(youtube.detect('UCabcdefghijklmnop12345'),
    { identifier: 'UCabcdefghijklmnop12345' });
  assert.equal(youtube.detect('https://example.com/feed'), null);
});

test('youtube.extractChannelFromHtml：从频道页提取 channel_id 与频道名', () => {
  const html = `<html><head>
    <meta property="og:title" content="硅谷小君聊科技">
    <link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCxyzXYZ12345678901234">
    </head><body><script>var ytInitialData = {"channelId":"UCxyzXYZ12345678901234"}</script></body></html>`;
  assert.deepEqual(youtube.extractChannelFromHtml(html),
    { identifier: 'UCxyzXYZ12345678901234', name: '硅谷小君聊科技' });
  assert.equal(youtube.extractChannelFromHtml('<html>nothing</html>'), null);
});

test('youtube.normalizeSource：UC 标识原样通过；含 UC 的链接免网络直接提取', async () => {
  assert.equal(await youtube.normalizeSource({ identifier: 'UCabcdefghijklmnop12345', name: 'x' }), null);
  const r = await youtube.normalizeSource({
    identifier: 'https://www.youtube.com/channel/UCabcdefghijklmnop12345',
    name: 'https://www.youtube.com/channel/UCabcdefghijklmnop12345',
  });
  assert.equal(r.identifier, 'UCabcdefghijklmnop12345');
});

test('x.normalizeSource：完整链接自愈为 handle，占位名改为 @handle', async () => {
  const r = await x.normalizeSource({ identifier: 'https://x.com/ilyasut', name: 'https://x.com/ilyasut' });
  assert.equal(r.identifier, 'ilyasut');
  assert.equal(r.name, '@ilyasut');
  // 已规范 + 名字非占位 -> 无需变更
  assert.equal(await x.normalizeSource({ identifier: 'ilyasut', name: 'Ilya' }), null);
  // 解析不出 handle -> 明确报错
  await assert.rejects(() => x.normalizeSource({ identifier: 'https://example.com/foo', name: 'n' }),
    /无法解析 X 用户名/);
});

test('prepareSource：规范化结果回写 DB（自愈存量错误源）', async () => {
  const db = memDb();
  const s = makeSource(db, {
    channel: 'x', identifier: 'https://x.com/ilyasut', name: 'https://x.com/ilyasut',
  });
  const prepared = await prepareSource(db, s);
  assert.equal(prepared.identifier, 'ilyasut');
  const fresh = db.prepare('SELECT identifier, name, site_url FROM sources WHERE id=?').get(s.id);
  assert.equal(fresh.identifier, 'ilyasut');
  assert.equal(fresh.name, '@ilyasut');
  assert.equal(fresh.site_url, 'https://x.com/ilyasut');
});

test('prepareSource：唯一键冲突时不炸，仅内存生效', async () => {
  const db = memDb();
  makeSource(db, { channel: 'x', identifier: 'ilyasut', name: 'Ilya 正主' });
  const dup = makeSource(db, { channel: 'x', identifier: 'https://x.com/ilyasut', name: 'https://x.com/ilyasut' });
  const prepared = await prepareSource(db, dup);
  assert.equal(prepared.identifier, 'ilyasut'); // 内存里已规范
  const fresh = db.prepare('SELECT identifier FROM sources WHERE id=?').get(dup.id);
  assert.equal(fresh.identifier, 'https://x.com/ilyasut'); // DB 保持原样（冲突被吞）
});
