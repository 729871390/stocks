import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import * as x from '../src/channels/x.js';

test('parseJsonLenient：容忍 markdown 围栏与前后缀文字', () => {
  assert.deepEqual(x.parseJsonLenient('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(x.parseJsonLenient('结果如下：[{"a":1}] 以上。'), [{ a: 1 }]);
  assert.deepEqual(x.parseJsonLenient('{"a":1}'), { a: 1 });
  assert.throws(() => x.parseJsonLenient('没有json'), /未找到 JSON/);
});

test('mapLlmTweet：有效链接提取ID；无链接用内容哈希幂等', () => {
  const t1 = x.mapLlmTweet({ url: 'https://x.com/ilyasut/status/1234567890123', text: 'hello', date: '2026-07-10' }, 'ilyasut');
  assert.equal(t1.id_str, '1234567890123');
  assert.equal(t1._url, 'https://x.com/ilyasut/status/1234567890123');

  const t2a = x.mapLlmTweet({ text: '同一条内容' }, 'ilyasut');
  const t2b = x.mapLlmTweet({ url: '编造的链接', text: '同一条内容' }, 'ilyasut');
  assert.match(t2a.id_str, /^llm-/);
  assert.equal(t2a.id_str, t2b.id_str); // 幂等：重复抓取不重复入库
  assert.equal(t2a._url, null);

  assert.equal(x.mapLlmTweet({ text: '   ' }, 'h'), null);
  assert.equal(x.mapLlmTweet(null, 'h'), null);
});

test('mapLlmTweet -> fetch：哈希ID条目不伪造 x.com 链接', async () => {
  const source = { id: 1, identifier: 'ilyasut' };
  const withUrl = await x.fetch(source, x.mapLlmTweet({ url: 'https://x.com/ilyasut/status/99999999999', text: 'a' }, 'ilyasut'));
  assert.equal(withUrl.url, 'https://x.com/ilyasut/status/99999999999');
  const noUrl = await x.fetch(source, x.mapLlmTweet({ text: 'b' }, 'ilyasut'));
  assert.equal(noUrl.url, null);
  assert.equal(noUrl.content_type, 'tweet');
});

test('mapNitterItem：提取推文ID、识别转发', () => {
  const t = x.mapNitterItem({
    link: 'https://xcancel.com/ilyasut/status/1234567890123#m',
    title: 'we trained a model', contentSnippet: 'we trained a model',
    isoDate: '2026-07-10T00:00:00Z', creator: '@ilyasut',
  }, 'ilyasut');
  assert.equal(t.id_str, '1234567890123');
  assert.equal(t.retweeted_status, undefined);

  const rt = x.mapNitterItem({
    link: 'https://xcancel.com/other/status/222#m',
    title: 'RT by @ilyasut: something', creator: '@other',
  }, 'ilyasut');
  assert.ok(rt.retweeted_status);

  assert.equal(x.mapNitterItem({ link: 'https://xcancel.com/about' }, 'h'), null);
});

test('discover 策略链：syndication 挂了自动降级到 nitter 镜像', async () => {
  // 本地 fixture 假扮 nitter 实例
  const nitterRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>模型训练新进展</title><link>http://127.0.0.1:9917/ilyasut/status/1234567890123#m</link>
    <guid>http://127.0.0.1:9917/ilyasut/status/1234567890123#m</guid>
    <pubDate>${new Date().toUTCString()}</pubDate><description>模型训练新进展</description></item>
    </channel></rss>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(nitterRss);
  }).listen(9917);

  const savedFetch = globalThis.fetch;
  const savedInstances = config.x.nitterInstances;
  globalThis.fetch = async url => {
    if (String(url).includes('syndication.twitter.com')) {
      return { ok: false, status: 404, text: async () => '' };
    }
    return savedFetch(url);
  };
  config.x.nitterInstances = ['http://127.0.0.1:9917'];
  try {
    const tweets = await x.discover({ identifier: 'ilyasut', config: '{}' });
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].id_str, '1234567890123');
    assert.equal(tweets[0].full_text, '模型训练新进展');
  } finally {
    globalThis.fetch = savedFetch;
    config.x.nitterInstances = savedInstances;
    server.close();
  }
});

test('discover 全链失败：聚合错误按 transient 记账（status 503，不误判 dead）', async () => {
  const savedFetch = globalThis.fetch;
  const savedInstances = config.x.nitterInstances;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  config.x.nitterInstances = ['http://127.0.0.1:1']; // 不可达
  try {
    await assert.rejects(
      () => x.discover({ identifier: 'ilyasut', config: '{}' }),
      e => e.status === 503 && /策略全部失败/.test(e.message) && /syndication/.test(e.message),
    );
  } finally {
    globalThis.fetch = savedFetch;
    config.x.nitterInstances = savedInstances;
  }
});

test('每源 config 可锁定单一策略 / 指定自建 RSS 桥', async () => {
  const nitterRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>bridge tweet</title><link>http://127.0.0.1:9918/ilyasut/status/555555555555#m</link>
    <guid>g1</guid><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(nitterRss);
  }).listen(9918);
  try {
    const tweets = await x.discover({
      identifier: 'ilyasut',
      config: JSON.stringify({ rssBridge: 'http://127.0.0.1:9918/{handle}/rss' }),
    });
    assert.equal(tweets[0].id_str, '555555555555');
  } finally {
    server.close();
  }
});
