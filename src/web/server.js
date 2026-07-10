import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seedJobs } from '../jobs/definitions.js';
import { config } from '../config.js';
import { router as sourcesRouter } from './routes/sources.js';
import { router as itemsRouter } from './routes/items.js';
import { router as reportsRouter } from './routes/reports.js';
import { router as adminRouter } from './routes/admin.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/public', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
  app.get('/', (req, res) => res.redirect('/items'));
  app.use(sourcesRouter);
  app.use(itemsRouter);
  app.use(reportsRouter);
  app.use(adminRouter);
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  migrate(db);
  seedJobs(db);
  const app = createApp();
  app.listen(config.web.port, () => console.log(`[web] listening on :${config.web.port}`));
}
