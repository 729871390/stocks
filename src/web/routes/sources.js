// 信息源管理：卡片网格主视图 + 详情弹窗 API + 添加（单条/批量识别）+ 批量操作 + 启停可验证四层。

import express from 'express';
import { getDb } from '../../db/connection.js';
import { layout, esc } from '../layout.js';
import { CHANNELS, CHANNEL_LABELS, X_INDUSTRY_TAGS, ROLES, PRIORITIES } from '../../core/taxonomy.js';
import { fmtDisplay, normDate } from '../../core/time.js';
import { config } from '../../config.js';
import { getAdapter, isValidChannel, ADAPTERS } from '../../channels/registry.js';
import { normalizeHandle } from '../../core/canonical.js';
import { nowUtc } from '../../core/time.js';
import { isIdle, computeStatus, resolveSiteUrl, logSourceChange } from '../../core/sourceWriters.js';
import { insertItems } from '../../core/ingest.js';
import { prepareSource } from '../../core/fetchSource.js';
import { enqueueTask } from '../../jobs/definitions.js';

export const router = express.Router();
const tz = () => config.timezones.display;

/* ---------------- 页面 ---------------- */

router.get('/sources', (req, res) => {
  const db = getDb();
  const sources = db.prepare(`SELECT * FROM sources WHERE deleted_at IS NULL ORDER BY name`).all();
  const groups = CHANNELS.map(ch => ({
    channel: ch,
    label: CHANNEL_LABELS[ch],
    sources: sources.filter(s => s.channel === ch),
  })).filter(g => g.sources.length);

  const grid = groups.map(g => `
    <div class="channel-group">
      <h2>${esc(g.label)}（${g.sources.length}）</h2>
      <div class="card-grid">
        ${g.sources.map(s => sourceCard(s)).join('')}
      </div>
    </div>`).join('');

  const body = `
    <div class="toolbar">
      <button class="btn btn-primary" data-action="open-add">＋ 添加信息源</button>
      <span class="kv">${sources.length} 个源</span>
    </div>
    <div id="batch-bar" class="batch-bar">
      <span id="batch-count"></span>
      <button class="btn" id="batch-toggle" data-action="batch-toggle"></button>
      <button class="btn" id="batch-priority" data-action="batch-priority"></button>
      <button class="btn btn-danger" data-action="batch-delete">删除</button>
    </div>
    ${grid || '<p class="kv">尚无信息源，点击“添加信息源”开始。</p>'}`;
  res.send(layout({ title: '信息源', body, active: '/sources' }));
});

function sourceCard(s) {
  // 卡片只有：复选框、源名（外链 site_url，点击不冒泡）、最新更新时间。故障红点、停用置灰。
  const faulty = s.enabled && (s.status === 'failing' || s.status === 'dead');
  const idle = isIdle(s);
  const latest = s.last_new_item_at
    ? `最新更新 ${fmtDisplay(s.last_new_item_at, tz())}`
    : (s.last_success_at ? '尚未更新' : '尚未成功抓取');
  return `
  <div class="source-card ${s.enabled ? '' : 'disabled'}" data-id="${s.id}" data-enabled="${s.enabled}" data-priority="${esc(s.priority)}">
    ${faulty ? '<span class="fault-dot"></span>' : ''}
    <div><input type="checkbox"> <span class="name">${s.site_url
      ? `<a href="${esc(s.site_url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
      : esc(s.name)}</span>
      ${s.priority === 'P0' ? '<span class="idle-tag" style="color:var(--green);border-color:var(--green)">核心</span>' : ''}
      ${idle ? '<span class="idle-tag" title="超30天无新内容（低活跃≠故障）">idle</span>' : ''}</div>
    <div class="meta">${esc(latest)}</div>
  </div>`;
}

/* ---------------- API ---------------- */

router.get('/api/sources/channels', (req, res) => {
  res.json({ channels: CHANNELS.map(c => ({ key: c, label: CHANNEL_LABELS[c] })) });
});

router.get('/api/sources/:id', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM sources WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'source not found' });
  const stats = db.prepare('SELECT * FROM source_stats WHERE source_id=?').get(s.id);
  const changes = db.prepare('SELECT action, created_at FROM source_changes WHERE source_id=? ORDER BY id DESC LIMIT 3').all(s.id);
  const job = db.prepare(`SELECT cron_expr, timezone FROM cron_jobs WHERE job_type IN ('fetch_general','fetch_x') AND enabled=1 LIMIT 1`).get();
  const statusLabels = { ok: '正常', failing: '异常', dead: '失效', paused: '已停用' };
  res.json({
    source: s,
    stats: stats ? {
      items_30d: stats.items_30d,
      highRatio: stats.high_grade_ratio_30d == null ? '—' : `${(stats.high_grade_ratio_30d * 100).toFixed(1)}%`,
      computedAt: fmtDisplay(stats.computed_at, tz()),
    } : null, // “统计待生成”——还没算与等于0是两个事实
    changes,
    diagnostics: {
      statusLabel: `${statusLabels[s.status] || s.status}${isIdle(s) ? '（idle：超30天无新内容，非故障）' : ''}`,
      lastAttempt: s.last_attempt_at ? fmtDisplay(s.last_attempt_at, tz()) : null,
      lastSuccess: s.last_success_at ? fmtDisplay(s.last_success_at, tz()) : null,
      lastNewItem: s.last_new_item_at ? fmtDisplay(s.last_new_item_at, tz()) : null,
      lastError: s.last_error,
      nextRun: s.enabled ? (job ? `${job.cron_expr}（${job.timezone}）` : '未配置调度') : '已停用，不参与调度',
    },
    xIndustryTags: X_INDUSTRY_TAGS,
    roles: ROLES,
    priorities: PRIORITIES,
  });
});

router.post('/api/sources', async (req, res) => {
  const db = getDb();
  const { channel, identifier, name } = req.body || {};
  if (!isValidChannel(channel)) return res.status(400).json({ error: `渠道无效：${channel}` });
  let ident = String(identifier || '').trim();
  if (!ident) return res.status(400).json({ error: '标识不能为空' });
  // 用户常贴完整链接：先用适配器 detect 提取规范标识（@handle 等异步解析由首抓 normalizeSource 完成）
  const detected = getAdapter(channel).detect?.(ident);
  if (detected) ident = detected.identifier;
  else if (channel === 'x') ident = normalizeHandle(ident);
  try {
    const r = db.prepare(`INSERT INTO sources (channel, identifier, name, created_at, updated_at)
      VALUES (?,?,?,?,?)`).run(channel, ident, name?.trim() || ident, nowUtc(), nowUtc());
    const id = r.lastInsertRowid;
    await resolveSiteUrl(db, id);
    logSourceChange(db, id, 'create', `${channel}:${ident}`);
    enqueueTask(db, 'init_source', { sourceId: id }); // 新源提交即初始化：立即首抓
    const s = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    res.json({ id, name: s.name });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '该源已存在' });
    res.status(500).json({ error: e.message });
  }
});

// 批量识别：逐行自动识别渠道（YouTube 链接解析 channel_id、X 提取 handle、其他 URL 探测 feed）
router.post('/api/sources/detect', async (req, res) => {
  const lines = String(req.body?.lines || '').split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const input of lines) {
    let detected = null;
    for (const ch of ['youtube', 'x']) {
      const d = ADAPTERS[ch].detect?.(input);
      if (d) { detected = { channel: ch, ...d }; break; }
    }
    // @handle 等需要异步解析成规范 identifier（如 youtube @handle -> UC 频道ID）
    if (detected && ADAPTERS[detected.channel].normalizeSource) {
      try {
        const norm = await ADAPTERS[detected.channel].normalizeSource({
          identifier: detected.identifier, name: detected.name || detected.identifier,
        });
        if (norm) detected = { ...detected, ...norm };
      } catch (e) {
        rows.push({ input, error: e.message });
        continue;
      }
    }
    if (!detected) {
      const probe = await probeFeed(input);
      if (probe) detected = probe;
    }
    rows.push(detected ? { input, ...detected } : { input, error: '无法识别（非 URL/handle 或探测不到 feed）' });
  }
  res.json({ rows });
});

async function probeFeed(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  try {
    const res = await globalThis.fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; invest-info-hub/1.0)' },
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    if (/<(rss|feed|rdf)[\s>]/i.test(text.slice(0, 2000))) {
      const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
      return { channel: 'rss', identifier: url.toString(), name: title?.trim() };
    }
    const alt = text.match(/<link[^>]+rel=["']alternate["'][^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/i);
    if (alt) {
      const href = (alt[0].match(/href=["']([^"']+)["']/) || [])[1];
      if (href) return { channel: 'rss', identifier: new URL(href, url).toString() };
    }
  } catch { /* unreachable */ }
  return null;
}

router.post('/api/sources/batch', async (req, res) => {
  const db = getDb();
  const rows = (req.body?.rows || []).filter(r => r.channel && r.identifier);
  let created = 0;
  for (const r of rows) {
    try {
      const ident = r.channel === 'x' ? normalizeHandle(r.identifier) : r.identifier;
      const ins = db.prepare(`INSERT INTO sources (channel, identifier, name, created_at, updated_at)
        VALUES (?,?,?,?,?)`).run(r.channel, ident, r.name?.trim() || ident, nowUtc(), nowUtc());
      await resolveSiteUrl(db, ins.lastInsertRowid);
      logSourceChange(db, ins.lastInsertRowid, 'create', `batch ${r.channel}:${ident}`);
      enqueueTask(db, 'init_source', { sourceId: ins.lastInsertRowid });
      created++;
    } catch { /* duplicates skipped */ }
  }
  res.json({ created });
});

router.post('/api/sources/:id/update', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM sources WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'source not found' });
  const { name, industry_tag, role, priority, notes } = req.body || {};
  db.prepare(`UPDATE sources SET name=?, industry_tag=?, role=?, priority=?, notes=?, updated_at=? WHERE id=?`)
    .run(name?.trim() || s.name, industry_tag || null, role || null,
      PRIORITIES.some(p => p.key === priority) ? priority : s.priority, notes || null, nowUtc(), s.id);
  logSourceChange(db, s.id, 'update');
  res.json({ ok: true });
});

// 启停可验证：后端返回变更后的真实状态，前端只按响应渲染；停用即时移出调度集合
router.post('/api/sources/:id/toggle', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM sources WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'source not found' });
  const enabled = s.enabled ? 0 : 1;
  db.prepare('UPDATE sources SET enabled=?, updated_at=? WHERE id=?').run(enabled, nowUtc(), s.id);
  computeStatus(db, s.id);
  logSourceChange(db, s.id, enabled ? 'enable' : 'disable');
  const fresh = db.prepare('SELECT * FROM sources WHERE id=?').get(s.id);
  res.json({ enabled: Boolean(fresh.enabled), status: fresh.status });
});

// 测试抓取：无条件拉最近内容回显“连通 ok · 取到最近 N 条 · 最新一条：标题（日期）· 新入库 M 条”
router.post('/api/sources/:id/test-fetch', async (req, res) => {
  const db = getDb();
  let s = db.prepare('SELECT * FROM sources WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'source not found' });
  try {
    s = await prepareSource(db, s); // 顺带自愈存错的 identifier
    const adapter = getAdapter(s.channel);
    const raws = await adapter.discover(s);
    const normalized = [];
    for (const raw of raws.slice(0, 20)) normalized.push(await adapter.fetch(s, raw));
    const latest = normalized[0];
    const result = insertItems(db, s, normalized);
    logSourceChange(db, s.id, 'test-fetch', `n=${raws.length} inserted=${result.inserted}`);
    const latestDate = latest?.published_at ? (fmtDisplay(normDate(latest.published_at), tz()) || latest.published_at) : '—';
    res.json({
      message: `连通 ok · 取到最近 ${raws.length} 条 · 最新一条：${latest?.title || latest?.text?.slice(0, 40) || '—'}（${latestDate}）· 新入库 ${result.inserted} 条`,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 软删除：历史条目保留显示“源名（已归档）”；询问后可连带删除条目
router.post('/api/sources/:id/delete', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM sources WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'source not found' });
  const { deleteItems } = req.body || {};
  const txn = db.transaction(() => {
    db.prepare('UPDATE sources SET deleted_at=?, enabled=0, updated_at=? WHERE id=?').run(nowUtc(), nowUtc(), s.id);
    if (deleteItems) db.prepare('DELETE FROM items WHERE source_id=?').run(s.id);
  });
  txn();
  computeStatus(db, s.id);
  logSourceChange(db, s.id, 'delete', deleteItems ? 'with-items' : 'keep-items');
  res.json({ ok: true });
});

router.post('/api/sources/batch-op', (req, res) => {
  const db = getDb();
  const { ids = [], op, enable, priority } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未选择源' });
  for (const id of ids) {
    const s = db.prepare('SELECT id FROM sources WHERE id=? AND deleted_at IS NULL').get(id);
    if (!s) continue;
    if (op === 'toggle') {
      db.prepare('UPDATE sources SET enabled=?, updated_at=? WHERE id=?').run(enable ? 1 : 0, nowUtc(), id);
      computeStatus(db, id);
      logSourceChange(db, id, enable ? 'enable' : 'disable', 'batch');
    } else if (op === 'priority') {
      db.prepare('UPDATE sources SET priority=?, updated_at=? WHERE id=?').run(priority === 'P0' ? 'P0' : 'P1', nowUtc(), id);
      logSourceChange(db, id, `priority:${priority}`, 'batch');
    } else if (op === 'delete') {
      db.prepare('UPDATE sources SET deleted_at=?, enabled=0, updated_at=? WHERE id=?').run(nowUtc(), nowUtc(), id);
      logSourceChange(db, id, 'delete', 'batch keep-items');
    }
  }
  res.json({ ok: true, count: ids.length });
});
