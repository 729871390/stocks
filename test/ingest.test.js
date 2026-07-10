import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, makeSource } from './helpers.js';
import { insertItems } from '../src/core/ingest.js';
import { normDate } from '../src/core/time.js';

function daysAgo(n) {
  return normDate(new Date(Date.now() - n * 86_400_000));
}

test('入库：external_id 幂等 + canonical 去重记 also_seen_in', () => {
  const db = memDb();
  const s1 = makeSource(db);
  const s2 = makeSource(db, { identifier: 'https://example.com/feed2' });

  const r1 = insertItems(db, s1, [
    { external_id: 'a', url: 'https://news.com/story?utm_source=rss', title: 'T1', published_at: daysAgo(1) },
  ]);
  assert.equal(r1.inserted, 1);

  // 同源同 external_id 幂等
  const r2 = insertItems(db, s1, [
    { external_id: 'a', url: 'https://news.com/story', title: 'T1', published_at: daysAgo(1) },
  ]);
  assert.equal(r2.inserted, 0);

  // 异源同 canonical -> 记入首见条目 also_seen_in，不新建
  const r3 = insertItems(db, s2, [
    { external_id: 'b', url: 'https://www.news.com/story/', title: 'T1 copy', published_at: daysAgo(1) },
  ]);
  assert.equal(r3.inserted, 0);
  assert.equal(r3.duplicates, 1);
  const first = db.prepare('SELECT also_seen_in FROM items').get();
  const seen = JSON.parse(first.also_seen_in);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source_id, s2.id);
});

test('入库：90 天全局截断 + 新源初始化条数截断', () => {
  const db = memDb();
  const s = makeSource(db);
  // 587 条陈年 episode 场景：全部超 90 天 -> 全部截断
  const old = Array.from({ length: 30 }, (_, i) => ({
    external_id: `old-${i}`, title: `old ${i}`, published_at: daysAgo(100 + i),
  }));
  assert.equal(insertItems(db, s, old).inserted, 0);

  // 新源初始化：只保留最近 initMaxItems（默认20）条
  const many = Array.from({ length: 50 }, (_, i) => ({
    external_id: `n-${i}`, title: `n ${i}`, published_at: daysAgo(i % 80),
  }));
  const r = insertItems(db, s, many);
  assert.equal(r.inserted, 20);
});

test('入库：last_new_item_at 事务内取 max(现值, 发布时间)，日期归一化', () => {
  const db = memDb();
  const s = makeSource(db);
  insertItems(db, s, [
    { external_id: 'x1', title: 'x1', published_at: 'Wed, 09 Jul 2025 14:30:00 GMT' },
  ]);
  let row = db.prepare('SELECT last_new_item_at FROM sources WHERE id=?').get(s.id);
  // 注意运行日期：published_at 需在 90 天窗口内才会入库；这里以相对时间重验
  const db2 = memDb();
  const s2 = makeSource(db2);
  const older = daysAgo(5); const newer = daysAgo(1);
  insertItems(db2, s2, [{ external_id: 'a', title: 'a', published_at: newer }]);
  insertItems(db2, s2, [{ external_id: 'b', title: 'b', published_at: older }]);
  row = db2.prepare('SELECT last_new_item_at FROM sources WHERE id=?').get(s2.id);
  assert.equal(row.last_new_item_at, newer); // 旧条目入库不回退时间戳
  const item = db2.prepare('SELECT published_at FROM items LIMIT 1').get();
  assert.match(item.published_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
