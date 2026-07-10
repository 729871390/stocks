// 事件聚类（弱合并，只折叠不并正文）与强合并（同内容多载体，合并正文）。
// 规则② 同源标题相似度只对视频/播客切片开放——新闻源同天多稿常提同一公司，开了必误并。
// 强合并 dryRun（config.cluster.strongMergeDryRun）期间只写 merge_preview 供人工抽查，不实际 hidden。

import { config } from '../config.js';
import { nowUtc, hoursBetween } from '../core/time.js';
import { titleSimilarity, longestCommonSubstring } from '../core/similarity.js';

function bestTitle(item) {
  return item.ai_title || item.title || '';
}

export function clusterAndMerge(db, { windowHours = 72 } = {}) {
  const since = nowUtc();
  const rows = db.prepare(`
    SELECT id, source_id, title, ai_title, companies, content_type, published_at, cluster_id,
           hidden, text, url, also_seen_in
    FROM items
    WHERE hidden=0 AND grade IS NOT NULL
      AND fetched_at >= datetime(?, '-' || ? || ' hours')
    ORDER BY id ASC`).all(since, windowHours);

  strongMerge(db, rows);
  weakCluster(db, rows.filter(r => !r._hiddenNow));
}

// ---- 强合并：标题规范化二元组相似度≥0.9 + 发布时差≤48h + 公司标签交集 ----
function strongMerge(db, rows) {
  const cfg = config.cluster;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]; const b = rows[j];
      if (a._hiddenNow || b._hiddenNow) continue;
      const dt = hoursBetween(a.published_at, b.published_at);
      if (dt === null || dt > cfg.strongWindowHours) continue;
      const ca = JSON.parse(a.companies || '[]');
      const cb = JSON.parse(b.companies || '[]');
      if (!ca.some(c => cb.includes(c))) continue;
      if (titleSimilarity(bestTitle(a), bestTitle(b)) < cfg.strongTitleSim) continue;

      // 保留最完整版本：正文更长者优先（全文源优先的代理指标）
      const [keep, hide] = (a.text || '').length >= (b.text || '').length ? [a, b] : [b, a];
      if (cfg.strongMergeDryRun) {
        db.prepare(`INSERT INTO merge_preview (keep_item_id, hide_item_id, reason, created_at)
          SELECT ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM merge_preview WHERE keep_item_id=? AND hide_item_id=?)`)
          .run(keep.id, hide.id, `titleSim>=${cfg.strongTitleSim} dt=${dt.toFixed(1)}h`, nowUtc(), keep.id, hide.id);
        continue;
      }
      const seen = JSON.parse(keep.also_seen_in || '[]');
      if (!seen.some(s => s.source_id === hide.source_id && s.url === hide.url)) {
        seen.push({ source_id: hide.source_id, url: hide.url });
      }
      db.prepare('UPDATE items SET also_seen_in=? WHERE id=?').run(JSON.stringify(seen), keep.id);
      db.prepare('UPDATE items SET hidden=1 WHERE id=?').run(hide.id); // 审计保留，不外显
      keep.also_seen_in = JSON.stringify(seen);
      hide._hiddenNow = true;
    }
  }
}

// ---- 弱合并：只共享 cluster_id 折叠展示，不并正文 ----
function weakCluster(db, rows) {
  const cfg = config.cluster;
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (x, y) => { parent.set(find(x), find(y)); };
  for (const r of rows) parent.set(r.id, r.cluster_id ?? r.id);
  for (const r of rows) if (!parent.has(parent.get(r.id))) parent.set(parent.get(r.id), parent.get(r.id));

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]; const b = rows[j];
      if (matchRule1(a, b, cfg) || matchRule2(a, b, cfg)) union(a.id, b.id);
    }
  }

  const upd = db.prepare('UPDATE items SET cluster_id=? WHERE id=?');
  const txn = db.transaction(() => {
    for (const r of rows) {
      const cid = find(r.id);
      if (r.cluster_id !== cid) upd.run(cid, r.id);
    }
  });
  txn();
}

// 规则①：核心实体重合≥2 且标题连续公共串≥6 字
function matchRule1(a, b, cfg) {
  const ca = JSON.parse(a.companies || '[]');
  const cb = JSON.parse(b.companies || '[]');
  const overlap = ca.filter(c => cb.includes(c)).length;
  if (overlap < cfg.weakEntityOverlap) return false;
  return longestCommonSubstring(bestTitle(a), bestTitle(b)) >= cfg.weakCommonSubstr;
}

// 规则②：同频道视频/播客 48h 内标题相似度≥0.3（严禁用于新闻源）
function matchRule2(a, b, cfg) {
  const mediaTypes = ['video', 'podcast'];
  if (!mediaTypes.includes(a.content_type) || !mediaTypes.includes(b.content_type)) return false;
  if (a.source_id !== b.source_id) return false;
  const dt = hoursBetween(a.published_at, b.published_at);
  if (dt === null || dt > cfg.mediaWindowHours) return false;
  return titleSimilarity(bestTitle(a), bestTitle(b)) >= cfg.mediaTitleSim;
}

// 事件簇规模 = 去重后的独立来源数（含 also_seen_in），热度信号输入
export function clusterSize(db, item) {
  const members = item.cluster_id
    ? db.prepare('SELECT source_id, also_seen_in FROM items WHERE cluster_id=? AND hidden=0').all(item.cluster_id)
    : [{ source_id: item.source_id, also_seen_in: item.also_seen_in }];
  const sources = new Set();
  for (const m of members) {
    sources.add(m.source_id);
    for (const s of JSON.parse(m.also_seen_in || '[]')) sources.add(s.source_id);
  }
  return sources.size;
}
