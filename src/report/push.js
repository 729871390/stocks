// 三路输出之 推送两路：微信（语义分条，条间 1.2s 防限流，绝不按字数切断句子）与飞书（富文本 post 单条）。
// 推送内容与网页内容同源同规则：一份数据（reports.content）两种渲染。

import { config } from '../config.js';
import { shortLink } from './shortlinks.js';

function reportContent(db, reportId) {
  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(reportId);
  if (!report) throw new Error(`report ${reportId} not found`);
  return { report, content: JSON.parse(report.content) };
}

function deepReadText(d) {
  const digest = d.digest;
  const statement = digest?.statement || d.event;
  const comment = digest?.comment || '';
  return `${String(d.slot).padStart(2, '0')} ${d.slotName}｜${d.title}\n${statement}${comment ? `\n点评：${comment}` : ''}`;
}

// 微信：语义分条——首条=报头+深读①，之后每篇深读一条，末条=重要信号+提醒日历。
// 单条超上限才按空行区块兜底再拆（绝不切断句子）。
export function buildWechatMessages(db, reportId) {
  const { report, content } = reportContent(db, reportId);
  const base = config.web.baseUrl;
  const dCode = shortLink(db, 'd', reportId);
  const msgs = [];

  const header = `📮 投资信息日报 ${report.report_date}\n${report.title}\n完整版：${base}/d/${dCode}`;
  const [first, ...rest] = content.deepReads;
  msgs.push(first ? `${header}\n\n${deepReadText(first)}` : header);
  for (const d of rest) msgs.push(deepReadText(d));

  const signalLines = content.signals
    .filter(m => m.items.length)
    .map(m => `▍${m.label}\n${m.items.map(it => `· [${it.grade}] ${it.title} ${base}/i/${it.code}`).join('\n')}`);
  const calLines = content.calendar.length
    ? `▍提醒日历\n${content.calendar.map(c => `· ${c.company} — ${c.next_earnings_date}`).join('\n')}`
    : '';
  msgs.push(['▍重要信号', ...signalLines, calLines].filter(Boolean).join('\n\n'));

  // 兜底：超上限按空行区块拆，绝不切断句子
  const maxLen = config.push.wechat.maxLen;
  const out = [];
  for (const m of msgs) {
    if (m.length <= maxLen) { out.push(m); continue; }
    let buf = '';
    for (const block of m.split('\n\n')) {
      if (buf && (buf.length + block.length + 2) > maxLen) { out.push(buf); buf = block; }
      else buf = buf ? `${buf}\n\n${block}` : block;
    }
    if (buf) out.push(buf);
  }
  return out;
}

// 飞书富文本 post 单条：深读（标题/陈述/点评+完整分析链接）+ 信号分组（标题为链接）+ 提醒日历
export function buildFeishuPost(db, reportId) {
  const { report, content } = reportContent(db, reportId);
  const base = config.web.baseUrl;
  const dCode = shortLink(db, 'd', reportId);
  const lines = [];
  for (const d of content.deepReads) {
    lines.push([{ tag: 'text', text: `${String(d.slot).padStart(2, '0')} ${d.slotName}｜${d.title}`, style: ['bold'] }]);
    lines.push([{ tag: 'text', text: d.digest?.statement || d.event }]);
    if (d.digest?.comment) lines.push([{ tag: 'text', text: `点评：${d.digest.comment}` }]);
    lines.push([{ tag: 'a', text: '完整分析 →', href: `${base}/d/${dCode}` }]);
    lines.push([{ tag: 'text', text: '' }]);
  }
  for (const m of content.signals) {
    if (!m.items.length) continue;
    lines.push([{ tag: 'text', text: `▍${m.label}`, style: ['bold'] }]);
    for (const it of m.items) {
      lines.push([{ tag: 'a', text: `[${it.grade}] ${it.title}`, href: `${base}/i/${it.code}` }]);
    }
  }
  if (content.calendar.length) {
    lines.push([{ tag: 'text', text: '▍提醒日历', style: ['bold'] }]);
    for (const c of content.calendar) lines.push([{ tag: 'text', text: `${c.company} — ${c.next_earnings_date}` }]);
  }
  return {
    msg_type: 'post',
    content: { post: { zh_cn: { title: `投资信息日报 ${report.report_date}｜${report.title}`, content: lines } } },
  };
}

export async function pushWechat(db, reportId) {
  const cfg = config.push.wechat;
  if (!cfg.enabled || !cfg.webhook) return { skipped: true, reason: 'wechat push not configured' };
  const msgs = buildWechatMessages(db, reportId);
  for (const [i, text] of msgs.entries()) {
    await globalThis.fetch(cfg.webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (i < msgs.length - 1) await new Promise(r => setTimeout(r, cfg.intervalMs));
  }
  return { sent: msgs.length };
}

export async function pushFeishu(db, reportId) {
  const cfg = config.push.feishu;
  if (!cfg.enabled || !cfg.webhook) return { skipped: true, reason: 'feishu push not configured' };
  const post = buildFeishuPost(db, reportId);
  await globalThis.fetch(cfg.webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(post),
    signal: AbortSignal.timeout(15_000),
  });
  return { sent: 1 };
}

export async function pushAll(db, reportId) {
  const wechat = await pushWechat(db, reportId).catch(e => ({ error: e.message }));
  const feishu = await pushFeishu(db, reportId).catch(e => ({ error: e.message }));
  return { wechat, feishu };
}

// IM 告警（不变量自检 / 核心源故障用）
export async function alertIm(text) {
  const cfg = config.push.im;
  if (!cfg.enabled || !cfg.webhook) { console.warn(`[alert] ${text}`); return { skipped: true }; }
  await globalThis.fetch(cfg.webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    signal: AbortSignal.timeout(15_000),
  });
  return { sent: 1 };
}
