// 入库运行器：统一负责 归一化 -> 90天截断 -> external_id 幂等 -> canonical 去重 ->
// last_new_item_at 记账 -> onInserted 钩子。下游管道对渠道零感知。

import { config } from '../config.js';
import { normDate, nowUtc, toDate } from './time.js';
import { canonicalizeUrl } from './canonical.js';

// items: 适配器 fetch() 产出的统一条目结构数组
// {external_id, url, title, text, author, published_at, content_type, media_urls?, duration?, engagement?, extra?}
export function insertItems(db, source, items, { onInserted = null } = {}) {
  const now = nowUtc();
  const cutoff = normDate(new Date(Date.now() - config.ingest.maxAgeDays * 86_400_000));
  const isNewSource = !db.prepare('SELECT 1 FROM items WHERE source_id=? LIMIT 1').get(source.id);

  // 归一化 + 全局 90 天截断（入库层规则，防陈年归档灌库）
  let candidates = items
    .map(it => ({ ...it, published_at: normDate(it.published_at) }))
    .filter(it => it.external_id != null && String(it.external_id).length > 0)
    .filter(it => !it.published_at || it.published_at >= cutoff);

  // 新源初始化双截断：最近 N 条 ∩ 不早于 M 天
  if (isNewSource && candidates.length > config.ingest.initMaxItems) {
    candidates = [...candidates]
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
      .slice(0, config.ingest.initMaxItems);
  }

  const insertStmt = db.prepare(`INSERT INTO items
    (source_id, external_id, url, canonical_url, title, text, author, published_at, fetched_at,
     content_type, media_urls, duration, engagement, extra, created_at)
    VALUES (@source_id, @external_id, @url, @canonical_url, @title, @text, @author, @published_at,
     @fetched_at, @content_type, @media_urls, @duration, @engagement, @extra, @created_at)`);
  const existsExternal = db.prepare('SELECT id FROM items WHERE source_id=? AND external_id=?');
  const findCanonical = db.prepare('SELECT id, also_seen_in FROM items WHERE canonical_url=? ORDER BY id ASC LIMIT 1');

  const inserted = [];
  let duplicates = 0;

  const txn = db.transaction(() => {
    for (const it of candidates) {
      const externalId = String(it.external_id);
      if (existsExternal.get(source.id, externalId)) continue; // 入库幂等

      const canonical = canonicalizeUrl(it.canonical_url || it.url);

      // canonical 去重：同 canonical 已存在 -> 记入首见条目的 also_seen_in，不新建
      if (canonical) {
        const dup = findCanonical.get(canonical);
        if (dup) {
          const seen = JSON.parse(dup.also_seen_in || '[]');
          if (!seen.some(s => s.source_id === source.id && s.url === (it.url || null))) {
            seen.push({ source_id: source.id, url: it.url || null });
            db.prepare('UPDATE items SET also_seen_in=? WHERE id=?').run(JSON.stringify(seen), dup.id);
          }
          duplicates++;
          continue;
        }
      }

      const row = {
        source_id: source.id,
        external_id: externalId,
        url: it.url || null,
        canonical_url: canonical,
        title: it.title || null,
        text: it.text || null,
        author: it.author || null,
        published_at: it.published_at,
        fetched_at: now,
        content_type: it.content_type || 'article',
        media_urls: JSON.stringify(it.media_urls || []),
        duration: it.duration ?? null,
        engagement: it.engagement ?? null,
        extra: JSON.stringify(it.extra || {}),
        created_at: now,
      };
      const res = insertStmt.run(row);
      inserted.push({ id: res.lastInsertRowid, ...row });

      // last_new_item_at：任一新条目入库时取 max(现值, 条目发布时间)，同一事务内写
      if (it.published_at) {
        db.prepare(`UPDATE sources SET last_new_item_at = MAX(COALESCE(last_new_item_at, ''), ?), updated_at=? WHERE id=?`)
          .run(it.published_at, now, source.id);
      }
    }
  });
  txn();

  if (onInserted) for (const row of inserted) onInserted(db, source, row);
  return { inserted: inserted.length, duplicates, items: inserted };
}
