// 深读三槽位选择 + 重要信号六模块定额。
// 入选池与五级分级完全一致：先 5 级，不足按 4 级补位，仍无则 3 级取热度最高，再无省略该槽位。
// 热度 = 事件簇独立来源数 + X 互动量级（log 加权）——只作排序输入，绝不写入正文。

import { config } from '../config.js';
import { tzDayRangeUtc } from '../core/time.js';
import { clusterSize } from '../pipeline/cluster.js';
import { CATEGORIES } from '../core/taxonomy.js';

export function heat(db, item) {
  const size = clusterSize(db, item);
  const engagement = item.engagement ? Math.log10(1 + item.engagement) : 0;
  return size + engagement;
}

function score(db, item, watchlist, pinnedCompanies, coreSourceIds) {
  const w = config.report.weights;
  const companies = JSON.parse(item.companies || '[]');
  let s = heat(db, item);
  if (companies.some(c => pinnedCompanies.has(c))) s += w.ownerPin;
  if (companies.some(c => watchlist.has(c))) s += w.watchlist;
  if (coreSourceIds.has(item.source_id)) s += w.coreSource;
  return s;
}

export function dayItems(db, dateStr, tz) {
  const { start, end } = tzDayRangeUtc(dateStr, tz);
  return db.prepare(`SELECT * FROM items
    WHERE hidden=0 AND grade IS NOT NULL
      AND fetched_at >= ? AND fetched_at < ?
    ORDER BY grade DESC, published_at DESC`).all(start, end);
}

// 固定三槽位：①今日重大事件（全池最高分）②重点公司与产品（公司类栏目且带公司标签）③研究前沿
export function selectDeepReads(db, items) {
  const watchRows = db.prepare('SELECT company, pinned FROM watchlist WHERE enabled=1').all();
  const watchlist = new Set(watchRows.map(r => r.company));
  const pinnedCompanies = new Set(watchRows.filter(r => r.pinned).map(r => r.company));
  const coreSourceIds = new Set(db.prepare(`SELECT id FROM sources WHERE priority='P0'`).all().map(r => r.id));

  // 同簇只取簇内最高分代表，避免同事件占两个槽位
  const byCluster = new Map();
  for (const it of items) {
    const key = it.cluster_id ?? `i${it.id}`;
    const cur = byCluster.get(key);
    if (!cur || it.grade > cur.grade) byCluster.set(key, it);
  }
  const pool = [...byCluster.values()].map(it => ({
    item: it,
    score: score(db, it, watchlist, pinnedCompanies, coreSourceIds),
  }));

  const used = new Set();
  const pickBest = candidates => {
    const sorted = candidates
      .filter(c => !used.has(c.item.id))
      .sort((a, b) => (b.item.grade - a.item.grade) || (b.score - a.score));
    for (const g of [5, 4]) {
      const hit = sorted.find(c => c.item.grade === g);
      if (hit) return hit.item;
    }
    const g3 = sorted.filter(c => c.item.grade === 3).sort((a, b) => b.score - a.score)[0];
    return g3?.item ?? null;
  };

  const companyCategories = ['funding', 'software_app', 'model_labs', 'compute_infra'];
  const slots = [
    { slot: 1, name: '今日重大事件', pick: () => pickBest(pool) },
    {
      slot: 2, name: '重点公司与产品',
      pick: () => pickBest(pool.filter(c =>
        companyCategories.includes(c.item.category) && JSON.parse(c.item.companies || '[]').length > 0)),
    },
    { slot: 3, name: '研究前沿', pick: () => pickBest(pool.filter(c => c.item.category === 'research')) },
  ];

  const selected = [];
  for (const s of slots) {
    const item = s.pick();
    if (item) { used.add(item.id); selected.push({ slot: s.slot, slotName: s.name, item }); }
  }
  return selected;
}

// 重要信号六模块：融资动向一个不落（当日全量）；其余各挑 3 条（等级 > 簇规模 > 热度，3 级起）
export function selectSignals(db, items, deepReadIds) {
  const modules = [];
  for (const cat of CATEGORIES) {
    let pool = items.filter(it => it.category === cat.key && !deepReadIds.has(it.id) && it.grade >= 3);
    // 簇内去重
    const byCluster = new Map();
    for (const it of pool) {
      const key = it.cluster_id ?? `i${it.id}`;
      if (!byCluster.has(key) || it.grade > byCluster.get(key).grade) byCluster.set(key, it);
    }
    pool = [...byCluster.values()].sort((a, b) =>
      (b.grade - a.grade) || (clusterSize(db, b) - clusterSize(db, a)) || (heat(db, b) - heat(db, a)));
    const picked = cat.key === 'funding' ? pool : pool.slice(0, 3);
    modules.push({ key: cat.key, label: cat.label, items: picked });
  }
  return modules;
}
