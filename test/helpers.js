import Database from 'better-sqlite3';
import { setDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { nowUtc } from '../src/core/time.js';

export function memDb() {
  const db = setDb(new Database(':memory:'));
  migrate(db);
  return db;
}

export function makeSource(db, over = {}) {
  const row = {
    channel: 'rss', identifier: `https://example.com/feed-${Math.random()}`, name: 'Test Source',
    priority: 'P1', ...over,
  };
  const r = db.prepare(`INSERT INTO sources (channel, identifier, name, priority, created_at, updated_at)
    VALUES (?,?,?,?,?,?)`).run(row.channel, row.identifier, row.name, row.priority, over.created_at || nowUtc(), nowUtc());
  return db.prepare('SELECT * FROM sources WHERE id=?').get(r.lastInsertRowid);
}
