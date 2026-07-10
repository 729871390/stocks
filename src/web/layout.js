// 服务端模板：所有页面共用布局。行内事件处理器会被模板求值吃掉引号与 \n ——
// 一律用事件委托 + data 属性（public/app.js），此处只输出静态 HTML。

import { GRADE_BADGES } from '../core/taxonomy.js';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 五色等级徽标（20px 圆）：全站同源引用
export function gradeBadge(grade) {
  if (!grade) return `<span class="badge badge-ungraded" title="未分级">·</span>`;
  const b = GRADE_BADGES[grade];
  const style = b.fill
    ? `background:${b.color};color:#fff;border:1px solid ${b.color}`
    : `background:transparent;color:${b.color};border:1.5px solid ${b.color}`;
  return `<span class="badge" style="${style}">${b.label}</span>`;
}

export function layout({ title, body, active = '' }) {
  const nav = [
    ['/sources', '信息源'],
    ['/items', '信息流'],
    ['/reports', '日报'],
    ['/admin', '系统'],
  ].map(([href, label]) =>
    `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/public/styles.css">
</head>
<body>
<header class="topnav"><span class="brand">投资信息中台</span><nav>${nav}</nav></header>
<main>${body}</main>
<script src="/public/app.js"></script>
</body>
</html>`;
}
