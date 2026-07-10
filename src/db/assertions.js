// 数据不变量每日自检（防复发机制）：名称+SQL+说明的可扩展结构。
// 任一违反即 IM 告警（jobs/definitions.js）并在系统设置页展示结果。
// 每次 schema 变更的三件套断言追加进此清单。

import { fileURLToPath } from 'node:url';
import { getDb } from './connection.js';
import { migrate } from './migrate.js';
import { nowUtc } from '../core/time.js';

export const ASSERTIONS = [
  {
    name: '有条目的源 last_new_item_at 不得为 NULL',
    sql: `SELECT COUNT(*) n FROM sources s
          WHERE s.last_new_item_at IS NULL
            AND EXISTS (SELECT 1 FROM items i WHERE i.source_id = s.id AND i.published_at IS NOT NULL)`,
    note: '“卡片显示尚未更新但 30 天条目有 43 条”类自相矛盾的根因检测',
  },
  {
    name: '缓存时间戳必须落在真实数据范围内',
    sql: `SELECT COUNT(*) n FROM sources s
          WHERE s.last_new_item_at IS NOT NULL
            AND s.last_new_item_at > (SELECT COALESCE(MAX(published_at), s.last_new_item_at)
                                      FROM items i WHERE i.source_id = s.id)`,
    note: 'last_new_item_at 不得超前于该源条目实际最大发布时间',
  },
  {
    name: '条目无悬空外键',
    sql: `SELECT COUNT(*) n FROM items i WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id)`,
    note: '软删除源保留行，绝不出现悬空引用',
  },
  {
    name: 'published_at 全部为归一化 UTC 格式',
    sql: `SELECT COUNT(*) n FROM items
          WHERE published_at IS NOT NULL
            AND published_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
    note: 'RFC-2822 入库会击穿字典序比较（时间铁律）',
  },
  {
    name: '可见条目分级覆盖率 100%（重试止损条目除外）',
    sql: `SELECT COUNT(*) n FROM items
          WHERE hidden = 0 AND grade IS NULL
            AND grade_retries < 5
            AND fetched_at < datetime('now', '-6 hours')`,
    note: '抓到了但超过 6 小时没分级 = 管道积压',
  },
  {
    name: '统计表新鲜度 ≤48h',
    sql: `SELECT COUNT(*) n FROM source_stats WHERE computed_at < datetime('now', '-48 hours')`,
    note: 'source_stats 缓存过期',
  },
  {
    name: 'hidden 条目必须归属某次合并（keep 方 also_seen_in 或 merge_preview 留痕）',
    sql: `SELECT COUNT(*) n FROM items h
          WHERE h.hidden = 1
            AND NOT EXISTS (SELECT 1 FROM items k WHERE k.also_seen_in LIKE '%"source_id":' || h.source_id || '%' AND k.id != h.id)
            AND NOT EXISTS (SELECT 1 FROM merge_preview mp WHERE mp.hide_item_id = h.id)`,
    note: 'hidden 唯一合法用途是真重复合并',
  },
  {
    name: '日报存储键为合法日期',
    sql: `SELECT COUNT(*) n FROM reports WHERE report_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    note: '日期非法会导致归档分组渲染 NaN',
  },
];

export async function runAssertions(db = getDb()) {
  const results = [];
  for (const a of ASSERTIONS) {
    let ok = false; let detail = '';
    try {
      const row = db.prepare(a.sql).get();
      ok = row.n === 0;
      detail = ok ? '' : `违反行数=${row.n}（${a.note}）`;
    } catch (e) {
      ok = false;
      detail = `断言执行失败：${e.message}`;
    }
    db.prepare('INSERT INTO assertion_results (name, ok, detail, ran_at) VALUES (?,?,?,?)')
      .run(a.name, ok ? 1 : 0, detail, nowUtc());
    results.push({ name: a.name, ok, detail });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  migrate(db);
  const results = await runAssertions(db);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  process.exitCode = results.some(r => !r.ok) ? 1 : 0;
}
