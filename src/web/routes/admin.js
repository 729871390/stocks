// 系统页：定时任务表、不变量自检结果、watchlist、强合并预演清单、审计日志。

import express from 'express';
import { getDb } from '../../db/connection.js';
import { layout, esc } from '../layout.js';
import { config } from '../../config.js';
import { fmtDisplay, nowUtc } from '../../core/time.js';
import { HANDLERS } from '../../jobs/definitions.js';

export const router = express.Router();
const tz = () => config.timezones.display;

router.get('/admin', (req, res) => {
  const db = getDb();
  const jobs = db.prepare('SELECT * FROM cron_jobs ORDER BY id').all();
  const lastRun = db.prepare(`SELECT name, ok, detail, ran_at FROM assertion_results
    WHERE ran_at = (SELECT MAX(ran_at) FROM assertion_results) ORDER BY id`).all();
  const watchlist = db.prepare('SELECT * FROM watchlist ORDER BY company').all();
  const previews = db.prepare(`SELECT mp.*, k.ai_title AS keep_title, h.ai_title AS hide_title
    FROM merge_preview mp LEFT JOIN items k ON k.id=mp.keep_item_id LEFT JOIN items h ON h.id=mp.hide_item_id
    ORDER BY mp.id DESC LIMIT 30`).all();
  const audits = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 30').all();

  const body = `
  <h2>定时任务（表驱动，每任务独立时区）</h2>
  <table class="admin">
    <tr><th>任务</th><th>表达式</th><th>时区</th><th>类型</th><th>启用</th><th>上次运行</th><th>状态</th><th>操作</th></tr>
    ${jobs.map(j => `<tr>
      <td>${esc(j.name)}</td><td>${esc(j.cron_expr)}</td><td>${esc(j.timezone)}</td><td>${esc(j.job_type)}</td>
      <td>${j.enabled ? '✅' : '⏸'}</td>
      <td>${j.last_run_at ? fmtDisplay(j.last_run_at, tz()) : '—'}</td>
      <td>${esc(j.last_status || '—')}${j.last_error ? ` <span style="color:var(--red)">${esc(j.last_error.slice(0, 80))}</span>` : ''}</td>
      <td><button class="btn" data-action="run-job" data-id="${j.id}">立即运行</button>
          <button class="btn" data-action="toggle-job" data-id="${j.id}">${j.enabled ? '停用' : '启用'}</button></td>
    </tr>`).join('')}
  </table>

  <h2 style="margin-top:28px">数据不变量自检（最近一次）</h2>
  <table class="admin">
    <tr><th></th><th>断言</th><th>详情</th><th>时间</th></tr>
    ${lastRun.length ? lastRun.map(a => `<tr>
      <td>${a.ok ? '✅' : '❌'}</td><td>${esc(a.name)}</td><td>${esc(a.detail || '')}</td><td>${fmtDisplay(a.ran_at, tz())}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="kv">尚未运行</td></tr>'}
  </table>

  <h2 style="margin-top:28px">重点公司清单（watchlist）</h2>
  <form data-action="add-watchlist" class="toolbar">
    <input type="text" name="company" placeholder="公司规范名" required style="padding:6px 8px;border:1px solid var(--line);border-radius:5px">
    <input type="date" name="next_earnings_date" style="padding:5px 8px;border:1px solid var(--line);border-radius:5px">
    <label class="kv"><input type="checkbox" name="pinned" value="1"> owner 钉选（深读 +1000）</label>
    <button class="btn btn-primary" type="submit">添加</button>
  </form>
  <table class="admin">
    <tr><th>公司</th><th>行业</th><th>下次财报</th><th>钉选</th><th>启用</th></tr>
    ${watchlist.map(w => `<tr><td>${esc(w.company)}</td><td>${esc(w.industry || '—')}</td>
      <td>${esc(w.next_earnings_date || '—')}</td><td>${w.pinned ? '📌' : ''}</td><td>${w.enabled ? '✅' : '⏸'}</td></tr>`).join('')}
  </table>

  <h2 style="margin-top:28px">强合并预演清单（dryRun=${config.cluster.strongMergeDryRun}，人工抽查无误伤后在 config/local.json 置 false 启用）</h2>
  <table class="admin">
    <tr><th>保留</th><th>拟隐藏</th><th>理由</th></tr>
    ${previews.map(p => `<tr><td><a href="/items/${p.keep_item_id}">${esc(p.keep_title || `#${p.keep_item_id}`)}</a></td>
      <td><a href="/items/${p.hide_item_id}">${esc(p.hide_title || `#${p.hide_item_id}`)}</a></td><td>${esc(p.reason || '')}</td></tr>`).join('')
      || '<tr><td colspan="3" class="kv">暂无</td></tr>'}
  </table>

  <h2 style="margin-top:28px">审计日志（最近 30 条）</h2>
  <table class="admin">
    <tr><th>时间</th><th>对象</th><th>动作</th><th>详情</th></tr>
    ${audits.map(a => `<tr><td>${fmtDisplay(a.created_at, tz())}</td><td>${esc(a.entity)}#${esc(a.entity_id || '')}</td>
      <td>${esc(a.action)}</td><td>${esc(a.detail || '')}</td></tr>`).join('')}
  </table>`;
  res.send(layout({ title: '系统', body, active: '/admin' }));
});

router.post('/api/admin/jobs/:id/run', async (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const handler = HANDLERS[job.job_type];
  if (!handler) return res.status(400).json({ error: `unknown job_type ${job.job_type}` });
  // 立即运行走同进程（阻塞时间可能较长的任务应经 worker，此处满足管理界面可控性）
  handler(db, JSON.parse(job.payload || '{}'))
    .then(r => db.prepare(`UPDATE cron_jobs SET last_run_at=?, last_status='ok', last_error=NULL WHERE id=?`).run(nowUtc(), job.id))
    .catch(e => db.prepare(`UPDATE cron_jobs SET last_run_at=?, last_status='error', last_error=? WHERE id=?`).run(nowUtc(), String(e.message).slice(0, 500), job.id));
  res.json({ started: true });
});

router.post('/api/admin/jobs/:id/toggle', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  db.prepare('UPDATE cron_jobs SET enabled=? WHERE id=?').run(job.enabled ? 0 : 1, job.id);
  res.json({ enabled: !job.enabled });
});

router.post('/api/admin/watchlist', (req, res) => {
  const db = getDb();
  const { company, next_earnings_date, pinned } = req.body || {};
  if (!company?.trim()) return res.status(400).json({ error: '公司名不能为空' });
  db.prepare(`INSERT INTO watchlist (company, next_earnings_date, pinned, created_at) VALUES (?,?,?,?)
    ON CONFLICT(company) DO UPDATE SET next_earnings_date=excluded.next_earnings_date, pinned=excluded.pinned`)
    .run(company.trim(), next_earnings_date || null, pinned ? 1 : 0, nowUtc());
  res.json({ ok: true });
});
