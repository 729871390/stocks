// 异步任务 worker：消费 tasks 表（初始化抓取、链式分级、补跑日报等）。

import { fileURLToPath } from 'node:url';
import { getDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { nowUtc } from '../core/time.js';
import { fetchSource } from '../core/fetchSource.js';
import { runGrading } from '../pipeline/grade.js';
import { runContextCompletion } from '../pipeline/context.js';
import { generateReport, waitForGradingDrain } from '../report/generate.js';

export const TASK_HANDLERS = {
  // 新源提交即初始化：立即首抓（截断在入库层保证），行内进度反馈由 web 层轮询任务状态
  async init_source(db, payload) {
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(payload.sourceId);
    if (!source) throw new Error(`source ${payload.sourceId} not found`);
    const result = await fetchSource(db, source);
    if (!result.ok) throw new Error(result.error);
    return result;
  },
  async grade(db) {
    await runContextCompletion(db);
    return runGrading(db);
  },
  async daily_report(db) {
    await waitForGradingDrain(db);
    return generateReport(db);
  },
};

export async function processOne(db) {
  const task = db.prepare(`SELECT * FROM tasks WHERE status='pending' AND run_at <= ?
    ORDER BY id ASC LIMIT 1`).get(nowUtc());
  if (!task) return false;
  db.prepare(`UPDATE tasks SET status='running', attempts=attempts+1 WHERE id=?`).run(task.id);
  try {
    const handler = TASK_HANDLERS[task.type];
    if (!handler) throw new Error(`unknown task type ${task.type}`);
    const result = await handler(db, JSON.parse(task.payload || '{}'));
    db.prepare(`UPDATE tasks SET status='done', last_error=? WHERE id=?`)
      .run(JSON.stringify(result ?? {}).slice(0, 500), task.id);
  } catch (e) {
    const failed = task.attempts + 1 >= 3;
    db.prepare(`UPDATE tasks SET status=?, last_error=? WHERE id=?`)
      .run(failed ? 'failed' : 'pending', String(e?.message || e).slice(0, 500), task.id);
  }
  return true;
}

export async function loop(db) {
  for (;;) {
    const had = await processOne(db).catch(e => { console.error(e); return false; });
    if (!had) await new Promise(r => setTimeout(r, 5000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  migrate(db);
  console.log('[worker] running');
  loop(db);
}
