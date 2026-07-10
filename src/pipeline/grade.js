// 分级管道：五级分级 + 四层标签 + AI 标题/摘要/so-what/事实。
// 窗口条件按【抓取时间】开窗，绝不用 COALESCE(发布时间, 抓取时间)——
// 老文新抓（补抓文章/老视频）否则永远卡在"待分级"。
// 分级失败重试上限止损，防解析失败条目无限烧 token。

import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { normDate, nowUtc, hoursBetween } from '../core/time.js';
import { INDUSTRY_TAGS, ACTION_TAGS, CATEGORIES } from '../core/taxonomy.js';
import { completeJson, llmConfigured } from '../llm/client.js';
import { clusterAndMerge } from './cluster.js';

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    grade: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    is_opinion: { type: 'boolean' },
    has_numbers: { type: 'boolean' },
    is_pure_retweet: { type: 'boolean' },
    industry_tags: { type: 'array', items: { type: 'string', enum: INDUSTRY_TAGS } },
    action_tag: { type: 'string', enum: ACTION_TAGS },
    companies: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    category: { type: 'string', enum: CATEGORIES.map(c => c.key) },
    ai_title: { type: 'string' },
    summary: { type: 'string' },
    so_what: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['grade', 'is_opinion', 'has_numbers', 'is_pure_retweet', 'industry_tags',
    'action_tag', 'companies', 'keywords', 'category', 'ai_title', 'summary', 'so_what', 'facts'],
  additionalProperties: false,
};

function gradingPrompt() {
  return fs.readFileSync(path.join(ROOT, 'prompts', 'grading.md'), 'utf8');
}

// 修正规则按序（程序化，不依赖模型自评）：
// 观点封顶 3 -> 无数字"重大"降 1 -> 命中重点公司清单升 1 -> 核心源升 1（与前条叠加总升幅封顶 +1）
// -> 48h 重复降 2 -> 纯转发封顶 2
export function applyCorrections(grade, flags) {
  let g = grade;
  if (flags.is_opinion) g = Math.min(g, 3);
  if (!flags.has_numbers && g >= 4) g -= 1;
  let up = 0;
  if (flags.watchlist_hit) up += 1;
  if (flags.core_source) up += 1;
  g += Math.min(up, 1); // 总升幅封顶 +1
  if (flags.dup_48h) g -= 2;
  if (flags.is_pure_retweet) g = Math.min(g, 2);
  return Math.max(1, Math.min(5, g));
}

export function selectQueue(db) {
  const windowStart = normDate(new Date(Date.now() - config.grading.windowHours * 3600_000));
  return db.prepare(`
    SELECT * FROM items
    WHERE grade IS NULL AND hidden = 0
      AND fetched_at >= ?
      AND grade_retries < ?
    ORDER BY fetched_at DESC
    LIMIT ?`).all(windowStart, config.grading.maxRetries, config.grading.batchLimit);
}

async function gradeOne(db, item) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(item.source_id);
  const body = [
    `来源：${source?.name || ''}（渠道 ${source?.channel || ''}）`,
    `作者：${item.author || ''}`,
    `发布时间：${item.published_at || '未知'}`,
    `标题：${item.title || '（无标题）'}`,
    `正文：\n${(item.text || '').slice(0, 6000)}`,
  ].join('\n');
  const out = await completeJson({
    tier: 'grading',
    system: gradingPrompt(),
    prompt: body,
    schema: GRADE_SCHEMA,
  });

  const watchlist = db.prepare('SELECT company FROM watchlist WHERE enabled=1').all().map(r => r.company);
  const flags = {
    is_opinion: out.is_opinion,
    has_numbers: out.has_numbers,
    is_pure_retweet: out.is_pure_retweet,
    watchlist_hit: (out.companies || []).some(c => watchlist.includes(c)),
    core_source: source?.priority === 'P0',
    dup_48h: isDup48h(db, item, out),
  };
  const grade = applyCorrections(out.grade, flags);

  db.prepare(`UPDATE items SET
      grade=?, industry_tags=?, action_tag=?, companies=?, keywords=?, category=?,
      ai_title=?, summary=?, so_what=?, facts=?, graded_at=?
    WHERE id=?`).run(
    grade,
    JSON.stringify((out.industry_tags || []).slice(0, 2)),
    out.action_tag,
    JSON.stringify(out.companies || []),
    JSON.stringify((out.keywords || []).slice(0, 3)),
    out.category,
    out.ai_title || item.title || '（无标题）', // ai_title 硬保证 100% 覆盖
    out.summary || '',
    out.so_what || '',
    JSON.stringify(out.facts || []),
    nowUtc(),
    item.id,
  );
  return grade;
}

// 48h 内重复无增量：已存在同公司交集且标题近似、发布更早、已分级的条目
function isDup48h(db, item, out) {
  const companies = out.companies || [];
  if (!companies.length || !item.published_at) return false;
  const rows = db.prepare(`
    SELECT id, title, ai_title, companies, published_at FROM items
    WHERE id != ? AND grade IS NOT NULL AND hidden = 0
      AND published_at <= ? AND published_at >= datetime(?, '-48 hours')
    ORDER BY published_at DESC LIMIT 200`).all(item.id, item.published_at, item.published_at);
  const myTitle = out.ai_title || item.title || '';
  for (const r of rows) {
    const theirCompanies = JSON.parse(r.companies || '[]');
    if (!companies.some(c => theirCompanies.includes(c))) continue;
    const t = r.ai_title || r.title || '';
    if (t && myTitle && similarityQuick(t, myTitle) >= 0.7) return true;
  }
  return false;
}

function similarityQuick(a, b) {
  const sa = new Set(a); const sb = new Set(b);
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  return inter / Math.max(sa.size, sb.size, 1);
}

export async function runGrading(db, { limit = null } = {}) {
  if (!llmConfigured()) {
    console.warn('grading skipped: ANTHROPIC_API_KEY not configured');
    return { graded: 0, failed: 0, skipped: true };
  }
  let queue = selectQueue(db);
  if (limit) queue = queue.slice(0, limit);
  let graded = 0; let failed = 0;
  for (const item of queue) {
    try {
      await gradeOne(db, item);
      graded++;
    } catch (e) {
      failed++;
      db.prepare('UPDATE items SET grade_retries = grade_retries + 1 WHERE id=?').run(item.id);
      console.warn(`grade failed item=${item.id} retry=${item.grade_retries + 1}: ${e.message}`);
    }
  }
  // 分级后进入聚类与强合并
  clusterAndMerge(db);
  checkCalibration(db);
  return { graded, failed };
}

// 校准线：单日 5 级 <3%、4 级 10-15%，超线自动告警（该收紧清单而不是放宽校准线）
export function checkCalibration(db) {
  const since = normDate(new Date(Date.now() - 24 * 3600_000));
  const rows = db.prepare(`SELECT grade, COUNT(*) n FROM items
    WHERE graded_at >= ? AND hidden=0 GROUP BY grade`).all(since);
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (total < 20) return null; // 样本太小不告警
  const share = g => (rows.find(r => r.grade === g)?.n || 0) / total;
  const { g5Max, g4Min, g4Max } = config.grading.shareAlerts;
  const alerts = [];
  if (share(5) > g5Max) alerts.push(`5级占比 ${(share(5) * 100).toFixed(1)}% 超过 ${g5Max * 100}%`);
  if (share(4) > g4Max) alerts.push(`4级占比 ${(share(4) * 100).toFixed(1)}% 超过 ${g4Max * 100}%`);
  if (alerts.length) {
    db.prepare('INSERT INTO audit_log (entity, action, detail, created_at) VALUES (?,?,?,?)')
      .run('grading', 'calibration_alert', alerts.join('；'), nowUtc());
    console.warn('calibration alert:', alerts.join('；'));
  }
  return alerts;
}
