// 日报：列表页（按月分组、行展开预览）+ 详情页（版心 1080px、打印 CSS、前后天导航）+ 短链。

import express from 'express';
import { getDb } from '../../db/connection.js';
import { layout, esc, gradeBadge } from '../layout.js';
import { config } from '../../config.js';
import { shortLink, resolveShortLink } from '../../report/shortlinks.js';

export const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 句边界截断防切半句（触发点回访 / 预览用）
export function clipAtSentence(text, max = 120) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('.'));
  return cut >= max * 0.4 ? head.slice(0, cut + 1) : head + '…';
}

router.get('/reports', (req, res) => {
  const db = getDb();
  const reports = db.prepare(`SELECT * FROM reports ORDER BY report_date DESC, report_type ASC`).all();
  const months = new Map();
  for (const r of reports) {
    // 日期非法的条目归“未归档”组，绝不渲染 NaN
    const month = DATE_RE.test(r.report_date) ? r.report_date.slice(0, 7) : '未归档';
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(r);
  }

  const body = [...months.entries()].map(([month, list]) => `
    <div class="report-month"><h2>${esc(month)}</h2>
    ${list.map(r => {
      const c = JSON.parse(r.content);
      const nSignals = c.signals?.reduce((a, m) => a + m.items.length, 0) || 0;
      return `
      <div class="report-row">
        <div class="head">
          <span class="date-tag">${esc(r.report_date)}${r.report_type === 'weekly' ? '（周报）' : ''}</span>
          <span>${esc(r.title || '')}</span>
          <span class="counts">深读×${c.deepReads?.length || 0} · 信号×${nSignals} · <a href="/reports/${esc(r.report_date)}?type=${r.report_type}">查看完整版</a></span>
        </div>
        <div class="preview">
          ${(c.deepReads || []).map(d => `<p><b>${String(d.slot).padStart(2, '0')} ${esc(d.slotName)}</b>｜${esc(d.title)}<br>
            <span class="kv clamp3">${esc(clipAtSentence(d.digest?.statement || d.event, 200))}</span></p>`).join('')}
          ${(c.signals || []).filter(m => m.items.length).map(m =>
            `<div class="kv">▍${esc(m.label)}：${m.items.slice(0, 3).map(it => `<a href="/i/${esc(it.code)}">${esc(it.title)}</a>`).join(' / ')}</div>`).join('')}
        </div>
      </div>`;
    }).join('')}</div>`).join('');

  res.send(layout({ title: '日报', body: body || '<p class="kv">尚无日报</p>', active: '/reports' }));
});

router.get('/reports/:date', (req, res) => {
  const db = getDb();
  const type = req.query.type === 'weekly' ? 'weekly' : 'daily';
  const r = db.prepare('SELECT * FROM reports WHERE report_date=? AND report_type=?').get(req.params.date, type);
  if (!r) return res.status(404).send(layout({ title: '404', body: '<p>该日无日报</p>', active: '/reports' }));
  res.send(renderReport(db, r));
});

function renderReport(db, r) {
  const c = JSON.parse(r.content);
  const db2 = db;
  const prev = db2.prepare(`SELECT report_date FROM reports WHERE report_date < ? AND report_type=? ORDER BY report_date DESC LIMIT 1`).get(r.report_date, r.report_type);
  const next = db2.prepare(`SELECT report_date FROM reports WHERE report_date > ? AND report_type=? ORDER BY report_date ASC LIMIT 1`).get(r.report_date, r.report_type);
  const history = db2.prepare(`SELECT report_date FROM reports WHERE report_type=? ORDER BY report_date DESC LIMIT 30`).all(r.report_type);

  const revisits = (c.revisits || []).length ? `
    <div class="revisit"><b>触发点回访</b>
      ${c.revisits.map(t => `<div>· ${esc(t.subject)}：${esc(clipAtSentence(t.criteria))}（窗口至 ${esc(t.window_end || '—')}）</div>`).join('')}
    </div>` : '';

  const deepReads = (c.deepReads || []).map(d => `
    <section>
      <div class="eyebrow">${String(d.slot).padStart(2, '0')} ${esc(d.slotName)}</div>
      <h2 class="dr-title">${esc(d.title)}</h2>
      <div class="body-text"><p><b>【事件】</b>${esc(d.event)}</p>
      ${String(d.analysis || '').split(/\n\n+/).filter(Boolean).map((p, i) => `<p>${i === 0 ? '<b>【分析】</b>' : ''}${esc(p)}</p>`).join('')}</div>
    </section>`).join('');

  const signals = `
    <section>
      <div class="eyebrow">重要信号</div>
      ${(c.signals || []).filter(m => m.items.length).map(m => `
        <h3 style="font-size:15px;margin:14px 0 6px">${esc(m.label)}${m.key === 'funding' ? '<span class="aux">（当日全量）</span>' : ''}</h3>
        ${m.items.map(it => `<div class="sig-item">${gradeBadge(it.grade)}<a href="/i/${esc(it.code)}">${esc(it.title)}</a>
          ${it.clusterSize > 1 ? `<span class="aux">×${it.clusterSize} 源</span>` : ''}</div>`).join('')}`).join('')}
    </section>`;

  const sections = (c.sections || []).length ? `
    <section>
      <div class="eyebrow">栏目速览</div>
      ${c.sections.map(sec => `
        <h3 style="font-size:15px;margin:14px 0 6px">${esc(sec.label)}<span class="aux">（${sec.items.length}）</span></h3>
        ${sec.items.map(it => `<div class="sig-item">${gradeBadge(it.grade)}<a href="/i/${esc(it.code)}">${esc(it.title)}</a>
          ${it.count > 1 ? `<span class="aux">×${it.count} 条同一事件</span>` : ''}</div>`).join('')}`).join('')}
    </section>` : '';

  const calendar = (c.calendar || []).length ? `
    <section>
      <div class="eyebrow">提醒日历</div>
      <table><tr><th>公司</th><th>下一次财报公布日期</th></tr>
      ${c.calendar.map(row => `<tr><td>${esc(row.company)}</td><td>${esc(row.next_earnings_date)}</td></tr>`).join('')}</table>
    </section>` : '';

  const appendix = (c.appendix || []).length ? `
    <section>
      <div class="eyebrow">附录 · 来源</div>
      <ol class="appendix-list">
      ${c.appendix.map(a => `<li>${esc(a.title)} — ${esc(a.source)} · ${esc((a.date || '').slice(0, 10))}${a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener">原文链接</a>` : ''}</li>`).join('')}
      </ol>
    </section>` : '';

  const body = `
  <div class="report">
    <h1 class="rpt-title">${esc(r.title || `投资信息日报 ${r.report_date}`)}</h1>
    <div class="rpt-nav">
      <span>${esc(r.report_date)}${r.report_type === 'weekly' ? '（周报）' : ''}</span>
      <a href="#" data-action="print-report">下载 PDF</a>
      ${prev ? `<a href="/reports/${prev.report_date}?type=${r.report_type}">← 前一天</a>` : ''}
      ${next ? `<a href="/reports/${next.report_date}?type=${r.report_type}">后一天 →</a>` : ''}
      <select data-nav-report data-type="${r.report_type}" class="no-print">
        ${history.map(h => `<option ${h.report_date === r.report_date ? 'selected' : ''}>${h.report_date}</option>`).join('')}
      </select>
      <a href="/reports">返回列表</a>
    </div>
    ${revisits}
    ${deepReads}
    ${signals}
    ${sections}
    ${calendar}
    ${appendix}
  </div>`;
  return layout({ title: r.title || `日报 ${r.report_date}`, body, active: '/reports' });
}

/* 短链：/d/<code> 日报、/i/<code> 条目 */
router.get('/d/:code', (req, res) => {
  const db = getDb();
  const link = resolveShortLink(db, req.params.code);
  if (!link || link.kind !== 'd') return res.status(404).send('not found');
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(link.target_id);
  if (!r) return res.status(404).send('not found');
  res.send(renderReport(db, r));
});

router.get('/i/:code', async (req, res) => {
  const db = getDb();
  const link = resolveShortLink(db, req.params.code);
  if (!link || link.kind !== 'i') return res.status(404).send('not found');
  const { itemDetailPage } = await import('./items.js');
  const html = itemDetailPage(db, link.target_id);
  if (!html) return res.status(404).send('not found');
  res.send(html);
});
