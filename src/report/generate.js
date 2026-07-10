// 日报生成：深读三槽位 -> 重要信号六模块 -> 栏目速览 -> 提醒日历 -> 附录来源。
// 社媒互动数据三重防线：prompt 禁令 + 正则复检强制重写 + 兜底剥离。
// 观察点结构化数据登记进触发点表，到期在头部“触发点回访”回显。

import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { nowUtc, dateInTz, tzDayRangeUtc } from '../core/time.js';
import { ENGAGEMENT_RE, HOLLOW_WORDS, CATEGORIES } from '../core/taxonomy.js';
import { completeJson, llmConfigured } from '../llm/client.js';
import { dayItems, selectDeepReads, selectSignals, heat } from './select.js';
import { clusterSize } from '../pipeline/cluster.js';
import { shortLink } from './shortlinks.js';
import { pushAll } from './push.js';

const DEEP_READ_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    event: { type: 'string' },
    analysis: { type: 'string' },
    observation: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        criteria: { type: 'string' },
        window_start: { type: 'string' },
        window_end: { type: 'string' },
      },
      required: ['subject', 'criteria', 'window_start', 'window_end'],
      additionalProperties: false,
    },
  },
  required: ['title', 'event', 'analysis', 'observation'],
  additionalProperties: false,
};

function prompt(name) {
  return fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8');
}

function violates(text) {
  const issues = [];
  if (ENGAGEMENT_RE.test(text)) issues.push('互动数据');
  for (const w of HOLLOW_WORDS) if (text.includes(w)) issues.push(`空洞词「${w}」`);
  return issues;
}

// 兜底剥离：按句边界删掉含互动数据的整句（三重防线之三）
export function stripEngagement(text) {
  return text
    .split(/(?<=[。！？!?\n])/)
    .filter(s => !ENGAGEMENT_RE.test(s))
    .join('')
    .trim();
}

async function writeDeepRead(db, entry) {
  const { item } = entry;
  const clusterMates = item.cluster_id
    ? db.prepare('SELECT * FROM items WHERE cluster_id=? AND hidden=0 AND id!=? LIMIT 5').all(item.cluster_id, item.id)
    : [];
  const material = [
    `【主条目】${item.ai_title || item.title}\n${(item.text || '').slice(0, 8000)}`,
    `关键事实：${item.facts}`,
    ...clusterMates.map(m => `【同事件来源】${m.ai_title || m.title}\n${(m.text || '').slice(0, 2000)}`),
  ].join('\n\n');

  let out = await completeJson({ tier: 'main', system: prompt('deep-read.md'), prompt: material, schema: DEEP_READ_SCHEMA });

  // 正则复检 -> 强制重写一次 -> 兜底剥离
  let issues = [...violates(out.event), ...violates(out.analysis)];
  if (issues.length) {
    out = await completeJson({
      tier: 'main',
      system: prompt('deep-read.md'),
      prompt: `${material}\n\n【重写要求】上一稿违反规则：${issues.join('、')}。请重写并彻底移除这些内容。`,
      schema: DEEP_READ_SCHEMA,
    });
    issues = [...violates(out.event), ...violates(out.analysis)];
    if (issues.length) {
      out.event = stripEngagement(out.event);
      out.analysis = stripEngagement(out.analysis);
    }
  }
  return out;
}

const DIGEST_SCHEMA = {
  type: 'object',
  properties: { statement: { type: 'string' }, comment: { type: 'string' } },
  required: ['statement', 'comment'],
  additionalProperties: false,
};

async function writeDigest(deepRead) {
  let out = await completeJson({
    tier: 'light', system: prompt('push-digest.md'),
    prompt: `标题：${deepRead.title}\n事件：${deepRead.event}\n分析：${deepRead.analysis}`,
    schema: DIGEST_SCHEMA,
  });
  if (violates(out.statement + out.comment).length) {
    out.statement = stripEngagement(out.statement);
    out.comment = stripEngagement(out.comment);
  }
  return out;
}

export async function generateReport(db, { date = null, push = true, reportType = 'daily' } = {}) {
  const tz = config.timezones.primary;
  const dateStr = date || dateInTz(new Date(), tz); // 存储键=生成地日期
  const existing = db.prepare('SELECT id FROM reports WHERE report_date=? AND report_type=?').get(dateStr, reportType);
  if (existing) return { skipped: true, reportId: existing.id, date: dateStr };

  const items = dayItems(db, dateStr, tz);
  const deepReadEntries = selectDeepReads(db, items);
  const deepReadIds = new Set(deepReadEntries.map(e => e.item.id));

  // 深读成稿（LLM 未配置时降级为摘要拼装，保证日报仍产出）
  const deepReads = [];
  for (const entry of deepReadEntries) {
    let piece;
    if (llmConfigured()) {
      try {
        const written = await writeDeepRead(db, entry);
        const digest = await writeDigest(written).catch(() => null);
        piece = { ...written, digest };
      } catch (e) {
        console.warn(`deep read failed item=${entry.item.id}: ${e.message}`);
      }
    }
    if (!piece) {
      piece = {
        title: entry.item.ai_title || entry.item.title || '',
        event: (JSON.parse(entry.item.facts || '[]')).join('；') || entry.item.summary || '',
        analysis: entry.item.so_what || '',
        observation: null,
        digest: null,
      };
    }
    deepReads.push({
      slot: entry.slot, slotName: entry.slotName, itemId: entry.item.id,
      grade: entry.item.grade, ...piece,
    });
  }

  const signals = selectSignals(db, items, deepReadIds).map(m => ({
    key: m.key, label: m.label,
    items: m.items.map(it => ({
      id: it.id, title: it.ai_title || it.title, grade: it.grade,
      clusterSize: clusterSize(db, it), code: shortLink(db, 'i', it.id),
    })),
  }));

  // 栏目速览：当日全部可见条目按栏目全量列出，同簇合并标注 ×N
  const sections = CATEGORIES.map(cat => {
    const catItems = items.filter(it => it.category === cat.key);
    const byCluster = new Map();
    for (const it of catItems) {
      const key = it.cluster_id ?? `i${it.id}`;
      const cur = byCluster.get(key);
      if (!cur) byCluster.set(key, { rep: it, count: 1 });
      else { cur.count++; if (it.grade > cur.rep.grade) cur.rep = it; }
    }
    return {
      key: cat.key, label: cat.label,
      items: [...byCluster.values()].map(({ rep, count }) => ({
        id: rep.id, title: rep.ai_title || rep.title, grade: rep.grade, count,
        code: shortLink(db, 'i', rep.id),
      })),
    };
  }).filter(s => s.items.length > 0);

  // 提醒日历：watchlist 全部启用公司的下一次财报日；条目 <calendarMinRows 整块自动隐藏
  const calRows = db.prepare(`SELECT company, next_earnings_date FROM watchlist
    WHERE enabled=1 AND next_earnings_date IS NOT NULL AND next_earnings_date >= date('now')
    ORDER BY next_earnings_date ASC`).all();
  const calendar = calRows.length >= config.report.calendarMinRows ? calRows : [];

  // 附录·来源
  const appendix = items.slice(0, 200).map(it => {
    const src = db.prepare('SELECT name FROM sources WHERE id=?').get(it.source_id);
    return { title: it.ai_title || it.title, source: src?.name || '', date: it.published_at, url: it.url };
  });

  // 触发点回访：窗口到期的观察点
  const revisits = db.prepare(`SELECT * FROM trigger_points
    WHERE status='open' AND window_end <= ? ORDER BY window_end ASC LIMIT 10`).all(dateStr);

  // AI 一句话标题
  let title = deepReads[0]?.title || `${dateStr} 投资信息日报`;
  if (llmConfigured() && deepReads.length) {
    try {
      const t = await completeJson({
        tier: 'light', system: prompt('report-title.md'),
        prompt: deepReads.map(d => d.title).join('\n'),
        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
      });
      title = t.title || title;
    } catch { /* keep fallback */ }
  }

  const content = { deepReads, signals, sections, calendar, appendix, revisits, tz };
  const res = db.prepare(`INSERT INTO reports (report_date, report_type, title, content, created_at)
    VALUES (?,?,?,?,?)`).run(dateStr, reportType, title, JSON.stringify(content), nowUtc());
  const reportId = res.lastInsertRowid;

  // 观察点登记进触发点表（句边界截断由渲染层负责）
  for (const d of deepReads) {
    if (d.observation?.subject) {
      db.prepare(`INSERT INTO trigger_points (report_id, item_id, subject, criteria, window_start, window_end, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(reportId, d.itemId, d.observation.subject, d.observation.criteria,
        d.observation.window_start || null, d.observation.window_end || null, nowUtc());
    }
  }

  shortLink(db, 'd', reportId);
  if (push) await pushAll(db, reportId).catch(e => console.warn(`push failed: ${e.message}`));
  return { reportId, date: dateStr, deepReads: deepReads.length, signals: signals.reduce((a, m) => a + m.items.length, 0) };
}

// 等待未分级清零（至多 waitUngradedMinutes 分钟），供日报任务生成前调用
export async function waitForGradingDrain(db) {
  const deadline = Date.now() + config.report.waitUngradedMinutes * 60_000;
  const windowStart = () => {
    const d = new Date(Date.now() - config.grading.windowHours * 3600_000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  while (Date.now() < deadline) {
    const n = db.prepare(`SELECT COUNT(*) n FROM items
      WHERE grade IS NULL AND hidden=0 AND fetched_at >= ? AND grade_retries < ?`)
      .get(windowStart(), config.grading.maxRetries).n;
    if (n === 0) return true;
    await new Promise(r => setTimeout(r, 30_000));
  }
  return false;
}
