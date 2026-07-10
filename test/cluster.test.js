import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, makeSource } from './helpers.js';
import { insertItems } from '../src/core/ingest.js';
import { clusterAndMerge, clusterSize } from '../src/pipeline/cluster.js';
import { normDate, nowUtc } from '../src/core/time.js';
import { config } from '../src/config.js';

function hoursAgo(n) {
  return normDate(new Date(Date.now() - n * 3600_000));
}

function grade(db, id, over = {}) {
  db.prepare(`UPDATE items SET grade=?, ai_title=?, companies=?, graded_at=? WHERE id=?`)
    .run(over.grade ?? 4, over.ai_title ?? null, JSON.stringify(over.companies ?? []), nowUtc(), id);
}

test('弱合并规则①：核心实体重合≥2 且标题公共串≥6 字 -> 同簇', () => {
  const db = memDb();
  const s1 = makeSource(db);
  const s2 = makeSource(db, { identifier: 'https://example.com/f2' });
  insertItems(db, s1, [{ external_id: 'a', title: 'x', url: 'https://a.com/1', published_at: hoursAgo(2) }]);
  insertItems(db, s2, [{ external_id: 'b', title: 'y', url: 'https://b.com/2', published_at: hoursAgo(3) }]);
  const [i1, i2] = db.prepare('SELECT id FROM items ORDER BY id').all();
  grade(db, i1.id, { ai_title: '微软向OpenAI追加投资100亿美元', companies: ['微软', 'OpenAI'] });
  grade(db, i2.id, { ai_title: '外媒：微软向OpenAI追加投资', companies: ['微软', 'OpenAI'] });
  clusterAndMerge(db);
  const rows = db.prepare('SELECT cluster_id FROM items ORDER BY id').all();
  assert.ok(rows[0].cluster_id !== null);
  assert.equal(rows[0].cluster_id, rows[1].cluster_id);
});

test('弱合并规则②：仅同频道视频/播客开放，新闻源不误并', () => {
  const db = memDb();
  const news = makeSource(db);
  insertItems(db, news, [
    { external_id: 'n1', title: 'x', url: 'https://n.com/1', published_at: hoursAgo(1) },
    { external_id: 'n2', title: 'y', url: 'https://n.com/2', published_at: hoursAgo(2) },
  ]);
  const [a, b] = db.prepare('SELECT id FROM items ORDER BY id').all();
  // 同天两篇"OpenAI 发布 X / OpenAI 审计 Y"：相似度过阈值但只有 1 个公司重合
  grade(db, a.id, { ai_title: 'OpenAI 发布新审计工具', companies: ['OpenAI'] });
  grade(db, b.id, { ai_title: 'OpenAI 发布新推理模型', companies: ['OpenAI'] });
  clusterAndMerge(db);
  const rows = db.prepare('SELECT id, cluster_id FROM items ORDER BY id').all();
  assert.ok(rows[0].cluster_id !== rows[1].cluster_id); // article 不适用规则②

  // 同频道播客切片：相似度≥0.3 即并
  const pod = makeSource(db, { channel: 'podcast', identifier: 'https://example.com/pod' });
  insertItems(db, pod, [
    { external_id: 'p1', title: 'x', content_type: 'podcast', published_at: hoursAgo(1) },
    { external_id: 'p2', title: 'y', content_type: 'podcast', published_at: hoursAgo(3) },
  ]);
  const pods = db.prepare(`SELECT id FROM items WHERE source_id=? ORDER BY id`).all(pod.id);
  grade(db, pods[0].id, { ai_title: '第42期：AI算力大辩论（上）', companies: [] });
  grade(db, pods[1].id, { ai_title: '第42期：AI算力大辩论（下）', companies: [] });
  clusterAndMerge(db);
  const podRows = db.prepare('SELECT cluster_id FROM items WHERE source_id=? ORDER BY id').all(pod.id);
  assert.equal(podRows[0].cluster_id, podRows[1].cluster_id);
});

test('强合并：dryRun 只写预演清单；关闭后 hidden+also_seen_in 保最完整', () => {
  const db = memDb();
  const s1 = makeSource(db);
  const s2 = makeSource(db, { identifier: 'https://example.com/f2' });
  insertItems(db, s1, [{ external_id: 'a', title: 'x', url: 'https://a.com/1', text: '短', published_at: hoursAgo(2) }]);
  insertItems(db, s2, [{ external_id: 'b', title: 'y', url: 'https://b.com/2', text: '这是一篇长得多的全文来源正文内容', published_at: hoursAgo(4) }]);
  const [i1, i2] = db.prepare('SELECT id FROM items ORDER BY id').all();
  grade(db, i1.id, { ai_title: '英伟达发布B300芯片售价4万美元', companies: ['英伟达'] });
  grade(db, i2.id, { ai_title: '英伟达发布B300芯片售价4万美元！', companies: ['英伟达'] });

  // dryRun（默认 true）：只留痕
  clusterAndMerge(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE hidden=1').get().n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM merge_preview').get().n >= 1);

  // 关闭 dryRun：hidden + also_seen_in，保留正文更长者
  const saved = config.cluster.strongMergeDryRun;
  config.cluster.strongMergeDryRun = false;
  try {
    clusterAndMerge(db);
    const hidden = db.prepare('SELECT * FROM items WHERE hidden=1').get();
    const kept = db.prepare('SELECT * FROM items WHERE hidden=0').get();
    assert.equal(hidden.id, i1.id); // 短正文被隐藏
    const seen = JSON.parse(kept.also_seen_in);
    assert.ok(seen.some(x => x.source_id === hidden.source_id));
    // 簇规模含 also_seen_in 的独立来源数
    assert.equal(clusterSize(db, kept), 2);
  } finally {
    config.cluster.strongMergeDryRun = saved;
  }
});
