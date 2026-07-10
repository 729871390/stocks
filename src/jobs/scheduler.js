// 表驱动调度器：cron_jobs 表（表达式/时区/启停/run_once/历史）；每任务独立时区（夏令/冬令自动）。
// 启动补跑守卫：检查最近一班应出的日报是否缺失，缺则自动补跑（进程重启撞上班点也不丢班）。

import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { config } from '../config.js';
import { nowUtc, dateInTz } from '../core/time.js';
import { HANDLERS, seedJobs, enqueueTask } from './definitions.js';

const scheduled = new Map(); // job.id -> cron task

export async function runJob(db, job) {
  const handler = HANDLERS[job.job_type];
  if (!handler) {
    db.prepare(`UPDATE cron_jobs SET last_run_at=?, last_status='error', last_error=? WHERE id=?`)
      .run(nowUtc(), `unknown job_type ${job.job_type}`, job.id);
    return;
  }
  console.log(`[job] start ${job.name}`);
  try {
    const result = await handler(db, JSON.parse(job.payload || '{}'));
    db.prepare(`UPDATE cron_jobs SET last_run_at=?, last_status='ok', last_error=NULL WHERE id=?`)
      .run(nowUtc(), job.id);
    if (job.run_once) db.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(job.id);
    console.log(`[job] done ${job.name}`, JSON.stringify(result ?? {}));
  } catch (e) {
    db.prepare(`UPDATE cron_jobs SET last_run_at=?, last_status='error', last_error=? WHERE id=?`)
      .run(nowUtc(), String(e?.message || e).slice(0, 500), job.id);
    console.error(`[job] failed ${job.name}: ${e.message}`);
  }
}

export function reload(db) {
  for (const [, task] of scheduled) task.stop();
  scheduled.clear();
  const jobs = db.prepare('SELECT * FROM cron_jobs WHERE enabled=1').all();
  for (const job of jobs) {
    if (!cron.validate(job.cron_expr)) {
      console.warn(`[scheduler] invalid cron for ${job.name}: ${job.cron_expr}`);
      continue;
    }
    const task = cron.schedule(job.cron_expr, () => {
      const fresh = db.prepare('SELECT * FROM cron_jobs WHERE id=? AND enabled=1').get(job.id);
      if (fresh) runJob(db, fresh);
    }, { timezone: job.timezone });
    scheduled.set(job.id, task);
  }
  console.log(`[scheduler] ${scheduled.size} jobs scheduled`);
}

// 启动补跑守卫：最近一班应出的日报缺失 -> 补跑
export function backfillGuard(db) {
  const tz = config.timezones.primary;
  const today = dateInTz(new Date(), tz);
  const nowInTz = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date());
  const jobRow = db.prepare(`SELECT * FROM cron_jobs WHERE job_type='daily_report' AND enabled=1`).get();
  if (!jobRow) return;
  const m = jobRow.cron_expr.match(/^(\d+)\s+(\d+)/);
  const mm = m ? Number(m[1]) : 30;
  const hh = m ? Number(m[2]) : 7;
  const dueTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const missing = !db.prepare(`SELECT 1 FROM reports WHERE report_date=? AND report_type='daily'`).get(today);
  if (missing && nowInTz >= dueTime) {
    console.log(`[scheduler] backfill guard: 补跑 ${today} 日报`);
    enqueueTask(db, 'daily_report');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  migrate(db);
  seedJobs(db);
  reload(db);
  backfillGuard(db);
  // 每 5 分钟重载表（管理界面改动生效）+ 补跑守卫
  cron.schedule('*/5 * * * *', () => { reload(db); backfillGuard(db); });
  console.log('[scheduler] running');
}
