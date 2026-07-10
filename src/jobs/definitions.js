// 定时任务清单（3.8）。cron_jobs 表驱动，此处提供 job_type -> 处理函数 与默认任务种子。
// 抓取后链式分级：任一抓取任务成功即入队 run_once 分级任务，不等整点。

import { config } from '../config.js';
import { nowUtc, dateInTz } from '../core/time.js';
import { fetchAll } from '../core/fetchSource.js';
import { runGrading } from '../pipeline/grade.js';
import { runContextCompletion } from '../pipeline/context.js';
import { runFullTextFetch } from '../pipeline/fulltext.js';
import { generateReport, waitForGradingDrain } from '../report/generate.js';
import { runAssertions } from '../db/assertions.js';
import { alertIm } from '../report/push.js';

export function enqueueTask(db, type, payload = {}, { delaySeconds = 0 } = {}) {
  const runAt = new Date(Date.now() + delaySeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO tasks (type, payload, run_at, created_at) VALUES (?,?,?,?)')
    .run(type, JSON.stringify(payload), runAt, nowUtc());
}

export const HANDLERS = {
  // 信息抓取（RSS/平台/微信/YouTube/播客轮询；完成即链式触发分级）
  async fetch_general(db) {
    const results = await fetchAll(db, { channels: ['rss', 'wechat', 'platform', 'youtube', 'podcast'] });
    const newItems = results.reduce((a, r) => a + (r.inserted || 0), 0);
    if (results.some(r => r.ok)) enqueueTask(db, 'grade'); // 链式分级
    await alertOnDeadCoreSources(db);
    return { sources: results.length, newItems };
  },

  // X 池抓取（批量 + 媒体旁路 + 上下文补全）
  async fetch_x(db) {
    const results = await fetchAll(db, { channels: ['x'] });
    await runContextCompletion(db);
    if (results.some(r => r.ok)) enqueueTask(db, 'grade');
    await alertOnDeadCoreSources(db);
    return { sources: results.length };
  },

  // 分级兜底（抓取后即时触发为主）：五级+标签+聚类+强合并，单批上限 config.grading.batchLimit
  async grade(db) {
    await runContextCompletion(db);
    return runGrading(db);
  },

  // 全文补抓
  async fulltext(db) {
    const n = await runFullTextFetch(db);
    return { fetched: n };
  },

  // 日报：生成+三路推送；生成前等待未分级清零（至多 15 分钟）
  async daily_report(db) {
    await waitForGradingDrain(db);
    return generateReport(db);
  },

  // 周报：本周最重要 3 件事 + 趋势观察，复用日报管道
  async weekly_report(db) {
    return generateReport(db, { reportType: 'weekly' });
  },

  // 重点公司财报 T-1 提醒
  async earnings_reminder(db) {
    const tz = config.timezones.primary;
    const tomorrow = dateInTz(new Date(Date.now() + 86_400_000), tz);
    const rows = db.prepare(`SELECT company FROM watchlist WHERE enabled=1 AND next_earnings_date=?`).all(tomorrow);
    if (rows.length) await alertIm(`📅 明日财报：${rows.map(r => r.company).join('、')}`);
    return { reminders: rows.length };
  },

  // 源统计缓存：近 30 天条目数与 4-5 级占比 -> source_stats（统计值不实时聚合）
  async source_stats(db) {
    const rows = db.prepare(`
      SELECT source_id,
             COUNT(*) AS items_30d,
             AVG(CASE WHEN grade >= 4 THEN 1.0 WHEN grade IS NOT NULL THEN 0.0 END) AS high_ratio
      FROM items WHERE fetched_at >= datetime('now', '-30 days')
      GROUP BY source_id`).all();
    const upsert = db.prepare(`INSERT INTO source_stats (source_id, items_30d, high_grade_ratio_30d, computed_at)
      VALUES (?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
      items_30d=excluded.items_30d, high_grade_ratio_30d=excluded.high_grade_ratio_30d, computed_at=excluded.computed_at`);
    const txn = db.transaction(() => {
      for (const r of rows) upsert.run(r.source_id, r.items_30d, r.high_ratio, nowUtc());
    });
    txn();
    return { sources: rows.length };
  },

  // 不变量自检：断言清单，违反即告警
  async assertions(db) {
    const results = await runAssertions(db);
    const failed = results.filter(r => !r.ok);
    if (failed.length) await alertIm(`⚠️ 数据不变量自检失败 ${failed.length} 项：\n${failed.map(f => `· ${f.name}：${f.detail}`).join('\n')}`);
    return { total: results.length, failed: failed.length };
  },

  // 公司归类增量：新出现公司按行业归类（轻量档批量）
  async company_catalog(db) {
    const { catalogNewCompanies } = await import('../pipeline/companies.js');
    return catalogNewCompanies(db);
  },
};

// 告警分级：普通源 dead 才告警；核心源（P0）failing 即告警
async function alertOnDeadCoreSources(db) {
  const rows = db.prepare(`SELECT name, priority, status, last_error FROM sources
    WHERE deleted_at IS NULL AND enabled=1
      AND (status='dead' OR (priority='P0' AND status='failing'))`).all();
  if (rows.length) {
    await alertIm(`🔴 信息源告警：\n${rows.map(r => `· [${r.priority}] ${r.name}（${r.status}）${r.last_error || ''}`).join('\n')}`);
  }
}

// 默认任务种子（全部信息源每天两班：湾区 06:30 + 北京 06:30，各自本地时区调度）
export const DEFAULT_JOBS = [
  { name: '信息抓取·北京班', cron_expr: '30 6 * * *', timezone: 'Asia/Shanghai', job_type: 'fetch_general' },
  { name: '信息抓取·湾区班', cron_expr: '30 6 * * *', timezone: 'America/Los_Angeles', job_type: 'fetch_general' },
  { name: 'X池抓取·北京班', cron_expr: '30 6 * * *', timezone: 'Asia/Shanghai', job_type: 'fetch_x' },
  { name: 'X池抓取·湾区班', cron_expr: '30 6 * * *', timezone: 'America/Los_Angeles', job_type: 'fetch_x' },
  { name: '分级兜底', cron_expr: '0 */2 * * *', timezone: 'Asia/Shanghai', job_type: 'grade' },
  { name: '全文补抓', cron_expr: '15 */6 * * *', timezone: 'Asia/Shanghai', job_type: 'fulltext' },
  { name: '日报', cron_expr: '30 7 * * *', timezone: 'Asia/Shanghai', job_type: 'daily_report' },
  { name: '财报T-1提醒', cron_expr: '0 9 * * *', timezone: 'Asia/Shanghai', job_type: 'earnings_reminder' },
  { name: '源统计缓存', cron_expr: '45 2 * * *', timezone: 'Asia/Shanghai', job_type: 'source_stats' },
  { name: '不变量自检', cron_expr: '10 3 * * *', timezone: 'Asia/Shanghai', job_type: 'assertions' },
  { name: '公司归类增量', cron_expr: '50 2 * * *', timezone: 'Asia/Shanghai', job_type: 'company_catalog' },
  { name: '周报', cron_expr: '0 8 * * 0', timezone: 'Asia/Shanghai', job_type: 'weekly_report' },
];

export function seedJobs(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO cron_jobs (name, cron_expr, timezone, job_type, created_at)
    VALUES (?,?,?,?,?)`);
  for (const j of DEFAULT_JOBS) insert.run(j.name, j.cron_expr, j.timezone, j.job_type, nowUtc());
}
