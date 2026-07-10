// 单进程一体化入口：Web + 表驱动调度器 + 异步 worker。
// 面向容器/云部署（SQLite 单写者，单进程最稳）；需要分进程时仍可用 pm2 + ecosystem.config.cjs。

import cron from 'node-cron';
import { getDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { seedJobs } from './jobs/definitions.js';
import { reload, backfillGuard } from './jobs/scheduler.js';
import { loop } from './jobs/worker.js';
import { createApp } from './web/server.js';
import { config } from './config.js';
import { authEnabled } from './web/auth.js';

const db = getDb();
migrate(db);
seedJobs(db);

reload(db);
backfillGuard(db);
cron.schedule('*/5 * * * *', () => { reload(db); backfillGuard(db); });

loop(db); // worker 循环（异步，不阻塞）

const app = createApp();
app.listen(config.web.port, () => {
  console.log(`[app] listening on :${config.web.port} (${config.web.baseUrl})`);
  if (!authEnabled()) console.warn('[app] ⚠️ 未设置 ADMIN_PASSWORD/VIEWER_PASSWORD，当前无访问控制（仅适合本机）');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn('[app] ⚠️ 未设置 ANTHROPIC_API_KEY，分级与深读将降级跳过');
  }
});
