import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

let db;

export function getDb(file = process.env.APP_DB_FILE || path.join(DATA_DIR, 'app.db')) {
  if (db) return db;
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// 测试专用：注入独立数据库实例（内存库）
export function setDb(instance) {
  db = instance;
  db.pragma('foreign_keys = ON');
  return db;
}
