// 信息流：全量可见原则（唯一隐藏=真重复）；分级只影响徽标/排序/筛选。
// 默认视图：全部条目不设时间窗；纯抓取时间倒序；簇折叠行用簇内最新抓取时间排序。
// 无显式等级筛选时只展开 3 级及以上，1-2 级折叠为一行；未分级灰点照常显示。

import express from 'express';
import { getDb } from '../../db/connection.js';
import { layout, esc, gradeBadge } from '../layout.js';
import { config } from '../../config.js';
import { fmtDisplay } from '../../core/time.js';
import { CHANNELS, CHANNEL_LABELS, INDUSTRY_TAGS, X_INDUSTRY_TAGS, ACTION_TAGS, ROLES, CONTENT_TYPES, PRIORITIES, CATEGORIES } from '../../core/taxonomy.js';

export const router = express.Router();
const tz = () => config.timezones.display;
const PAGE_SIZE = 100;

router.get('/items', (req, res) => {
  const db = getDb();
  const q = req.query;
  const where = ['i.hidden = 0'];
  const params = [];
  const multi = (key, column) => {
    const v = q[key];
    if (!v) return;
    const vals = String(v).split(',').filter(Boolean);
    if (!vals.length) return;
    where.push(`${column} IN (${vals.map(() => '?').join(',')})`);
    params.push(...vals);
  };

  multi('source', 'i.source_id');
  multi('channel', 's.channel');
  multi('ctype', 'i.content_type');
  multi('priority', 's.priority');
  multi('xindustry', 's.industry_tag');
  multi('role', 's.role');
  multi('category', 'i.category');
  if (q.grade) {
    const vals = String(q.grade).split(',').filter(Boolean).map(Number);
    where.push(`i.grade IN (${vals.map(() => '?').join(',')})`);
    params.push(...vals);
  }
  if (q.tag) { // 标签八类：六行业 + 融资 + 人员变动
    const vals = String(q.tag).split(',').filter(Boolean);
    const clauses = vals.map(v => {
      if (v === '融资并购' || v === '人员变动') { params.push(v); return `i.action_tag = ?`; }
      params.push(`%"${v}"%`); return `i.industry_tags LIKE ?`;
    });
    where.push(`(${clauses.join(' OR ')})`);
  }
  if (q.company) {
    const vals = String(q.company).split(',').filter(Boolean);
    where.push(`(${vals.map(() => `i.companies LIKE ?`).join(' OR ')})`);
    params.push(...vals.map(v => `%"${v}"%`));
  }
  if (q.q) { // 搜索=标题关键词全量匹配（LIKE），不走全文索引
    where.push(`(i.title LIKE ? OR i.ai_title LIKE ?)`);
    params.push(`%${q.q}%`, `%${q.q}%`);
  }
  if (q.from) { where.push('i.fetched_at >= ?'); params.push(`${q.from} 00:00:00`); }
  if (q.to) { where.push('i.fetched_at <= ?'); params.push(`${q.to} 23:59:59`); }

  const page = Math.max(1, Number(q.page) || 1);
  const rows = db.prepare(`
    SELECT i.*, s.name AS source_name, s.channel AS source_channel, s.deleted_at AS source_deleted,
      COALESCE((SELECT MAX(fetched_at) FROM items c WHERE c.cluster_id = i.cluster_id AND c.hidden=0), i.fetched_at) AS sort_key
    FROM items i JOIN sources s ON s.id = i.source_id
    WHERE ${where.join(' AND ')}
    ORDER BY sort_key DESC, i.fetched_at DESC
    LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
  const hasMore = rows.length > PAGE_SIZE;
  const items = rows.slice(0, PAGE_SIZE);

  // 簇折叠：同簇只显示代表条目（等级最高，簇行排序用簇内最新抓取时间=sort_key）
  const seenClusters = new Set();
  const display = [];
  for (const it of items) {
    if (it.cluster_id) {
      if (seenClusters.has(it.cluster_id)) continue;
      seenClusters.add(it.cluster_id);
      it._clusterCount = db.prepare('SELECT COUNT(*) n FROM items WHERE cluster_id=? AND hidden=0').get(it.cluster_id).n;
    }
    display.push(it);
  }

  const gradeFilterOn = Boolean(q.grade);
  const lowRows = gradeFilterOn ? [] : display.filter(it => it.grade !== null && it.grade <= 2);
  const rowsHtml = display.map(it => {
    const low = !gradeFilterOn && it.grade !== null && it.grade <= 2;
    return itemRow(it, { hiddenByDefault: low });
  }).join('');

  // 空态区分两个事实：库里压根没条目（引导去加源）vs 有条目但筛选无命中
  let emptyHint = '';
  if (!rowsHtml) {
    const totalItems = db.prepare('SELECT COUNT(*) n FROM items WHERE hidden=0').get().n;
    if (totalItems === 0) {
      const nSources = db.prepare('SELECT COUNT(*) n FROM sources WHERE deleted_at IS NULL AND enabled=1').get().n;
      const nFailing = db.prepare(`SELECT COUNT(*) n FROM sources WHERE deleted_at IS NULL AND enabled=1 AND status IN ('failing','dead')`).get().n;
      emptyHint = nSources === 0
        ? '<p class="kv" style="padding:16px">库里还没有任何条目 —— 先到 <a href="/sources">信息源</a> 页添加源，抓取后条目会出现在这里。</p>'
        : `<p class="kv" style="padding:16px">库里还没有任何条目。已添加 ${nSources} 个源${nFailing ? `（其中 ${nFailing} 个抓取失败——去 <a href="/sources">信息源</a> 页点开红点卡片，用「测试抓取」看失败原因）` : '，等下一班抓取或在源详情里点「测试抓取」立即拉取'}。</p>`;
    } else {
      emptyHint = '<p class="kv" style="padding:16px">无匹配条目（当前筛选条件下）—— 点「重置」查看全部。</p>';
    }
  }

  const body = `
    ${filterPanel(db, q)}
    <div class="items-list">
      ${lowRows.length ? `<div class="collapse-line">另有 ${lowRows.length} 条低等级条目 · 点击展开</div>` : ''}
      ${rowsHtml || emptyHint}
    </div>
    <div class="toolbar">
      ${page > 1 ? `<a class="btn" href="${pageUrl(q, page - 1)}">上一页</a>` : ''}
      ${hasMore ? `<a class="btn" href="${pageUrl(q, page + 1)}">下一页</a>` : ''}
    </div>`;
  res.send(layout({ title: '信息流', body, active: '/items' }));
});

function pageUrl(q, page) {
  const p = new URLSearchParams(q);
  p.set('page', String(page));
  return `/items?${p.toString()}`;
}

function itemRow(it, { hiddenByDefault = false } = {}) {
  const industry = JSON.parse(it.industry_tags || '[]')[0];
  const companies = JSON.parse(it.companies || '[]').slice(0, 2).join('/');
  const threePart = [industry, companies, it.action_tag].filter(Boolean).map(t => `[${esc(t)}]`).join('');
  return `
  <div class="item-row ${hiddenByDefault ? 'low-grade' : ''}" ${hiddenByDefault ? 'style="display:none"' : ''}>
    <span class="time">${fmtDisplay(it.fetched_at, tz())}</span>
    ${gradeBadge(it.grade)}
    <span class="title"><a href="/items/${it.id}">${esc(it.ai_title || it.title || '（无标题）')}</a>
      ${it._clusterCount > 1 ? `<span class="cluster-tag">×${it._clusterCount} 同一事件</span>` : ''}</span>
    <span class="tags">${threePart} · ${esc(it.source_name)}${it.source_deleted ? '（已归档）' : ''}</span>
  </div>`;
}

function filterPanel(db, q) {
  const on = (key, val) => String(q[key] || '').split(',').includes(String(val)) ? 'on' : '';
  const chip = (key, val, label) =>
    `<span class="chip ${on(key, val)}" data-filter="${key}" data-value="${esc(String(val))}">${esc(label)}</span>`;

  const sources = db.prepare('SELECT id, name, channel FROM sources WHERE deleted_at IS NULL ORDER BY channel, name').all();
  const sourceRows = CHANNELS.map(ch => {
    const list = sources.filter(s => s.channel === ch);
    if (!list.length) return '';
    return `<div class="row"><span class="label">${esc(CHANNEL_LABELS[ch])}</span>${list.map(s => chip('source', s.id, s.name)).join('')}</div>`;
  }).join('');

  const companies = db.prepare('SELECT company, industry FROM company_catalog ORDER BY industry, company LIMIT 80').all();
  const companyGroups = new Map();
  for (const c of companies) {
    const key = c.industry || '未归类';
    if (!companyGroups.has(key)) companyGroups.set(key, []);
    companyGroups.get(key).push(c.company);
  }
  const companyRows = [...companyGroups.entries()].map(([ind, list]) =>
    `<div class="row"><span class="label">${esc(ind)}</span>${list.map(c => chip('company', c, c)).join('')}</div>`).join('');

  const tagOptions = [...INDUSTRY_TAGS.filter(t => t !== '其他'), '融资并购', '人员变动'];

  return `
  <div class="filter-panel">
    <div class="row"><span class="label">搜索</span><input type="text" name="q" value="${esc(q.q || '')}" placeholder="标题关键词" style="width:220px"></div>
    <div class="row"><span class="label">时间</span>
      <input type="date" name="from" value="${esc(q.from || '')}"> — <input type="date" name="to" value="${esc(q.to || '')}"><span class="kv">（默认全部）</span></div>
    <div class="row"><span class="label">等级</span>${[5, 4, 3, 2, 1].map(g => chip('grade', g, `${g} 级`)).join('')}</div>
    <div class="row"><span class="label">标签</span>${tagOptions.map(t => chip('tag', t, t)).join('')}</div>
    <div class="row"><span class="label">栏目</span>${CATEGORIES.map(c => chip('category', c.key, c.label)).join('')}</div>
    <details><summary class="kv" style="cursor:pointer">数据源 / 公司 / 更多维度</summary>
      ${sourceRows}
      ${companyRows}
      <div class="row"><span class="label">渠道</span>${CHANNELS.map(c => chip('channel', c, CHANNEL_LABELS[c])).join('')}</div>
      <div class="row"><span class="label">X 行业</span>${X_INDUSTRY_TAGS.map(t => chip('xindustry', t, t)).join('')}</div>
      <div class="row"><span class="label">角色</span>${ROLES.map(r => chip('role', r, r)).join('')}</div>
      <div class="row"><span class="label">内容类型</span>${CONTENT_TYPES.map(t => chip('ctype', t, t)).join('')}</div>
      <div class="row"><span class="label">源优先级</span>${PRIORITIES.map(p => chip('priority', p.key, `${p.key} ${p.label}`)).join('')}</div>
    </details>
    <div class="row" style="margin-top:8px">
      <button class="btn btn-primary" data-action="apply-filters">应用</button>
      <button class="btn" data-action="reset-filters">重置</button>
    </div>
  </div>`;
}

/* ---------------- 详情页 ---------------- */

router.get('/items/:id', (req, res) => {
  const db = getDb();
  const html = itemDetailPage(db, req.params.id);
  if (!html) return res.status(404).send(layout({ title: '404', body: '<p>条目不存在</p>' }));
  res.send(html);
});

// 详情页渲染（/items/:id 与免登录短链 /i/<code> 共用）
export function itemDetailPage(db, id) {
  const it = db.prepare(`SELECT i.*, s.name AS source_name, s.deleted_at AS source_deleted
    FROM items i JOIN sources s ON s.id=i.source_id WHERE i.id=?`).get(id);
  if (!it) return null;

  const alsoSeen = JSON.parse(it.also_seen_in || '[]').map(a => {
    const src = db.prepare('SELECT name FROM sources WHERE id=?').get(a.source_id);
    return `<li>${esc(src?.name || `源#${a.source_id}`)}${a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener">原文</a>` : ''}</li>`;
  }).join('');
  const facts = JSON.parse(it.facts || '[]').map(f => `<li>${esc(f)}</li>`).join('');
  const media = JSON.parse(it.media_urls || '[]').map(u => `<img src="${esc(u)}" style="max-width:160px;max-height:120px;border-radius:6px;margin:4px" loading="lazy">`).join('');
  const industry = JSON.parse(it.industry_tags || '[]').map(t => `[${esc(t)}]`).join('');
  const companies = JSON.parse(it.companies || '[]').map(t => `[${esc(t)}]`).join('');

  const body = `
  <div class="detail">
    <h1>${esc(it.ai_title || it.title || '（无标题）')}</h1>
    <div class="meta-line">${gradeBadge(it.grade)} ${esc(it.source_name)}${it.source_deleted ? '（已归档）' : ''}
      · ${esc(it.author || '')} · 发布 ${fmtDisplay(it.published_at, tz()) || '—'} · 抓取 ${fmtDisplay(it.fetched_at, tz())}
      ${it.url ? ` · <a class="btn" style="padding:2px 10px" href="${esc(it.url)}" target="_blank" rel="noopener">查看原文</a>` : ''}</div>
    <div class="meta-line">${industry}${companies}${it.action_tag ? `[${esc(it.action_tag)}]` : ''} ${JSON.parse(it.keywords || '[]').map(k => `#${esc(k)}`).join(' ')}</div>
    ${it.so_what ? `<div class="sowhat">${esc(it.so_what)}</div>` : ''}
    ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
    ${facts ? `<h4>客观事实</h4><ul class="fact-list">${facts}</ul>` : ''}
    ${alsoSeen ? `<h4>同内容载体</h4><ul>${alsoSeen}</ul>` : ''}
    ${media ? `<div>${media}</div>` : ''}
    <details><summary>原文（默认折叠）</summary><div style="white-space:pre-wrap;margin-top:8px">${esc(it.text || '（无正文）')}</div></details>
  </div>`;
  return layout({ title: it.ai_title || it.title || '条目', body, active: '/items' });
}
