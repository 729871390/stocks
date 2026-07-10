// 短链系统：/d/<code> 日报、/i/<code> 条目。code 即凭据（免 token 可读不可枚举），幂等复用。
import crypto from 'node:crypto';
import { nowUtc } from '../core/time.js';

export function shortLink(db, kind, targetId) {
  const existing = db.prepare('SELECT code FROM short_links WHERE kind=? AND target_id=?').get(kind, targetId);
  if (existing) return existing.code;
  for (;;) {
    const code = crypto.randomBytes(6).toString('base64url');
    try {
      db.prepare('INSERT INTO short_links (code, kind, target_id, created_at) VALUES (?,?,?,?)')
        .run(code, kind, targetId, nowUtc());
      return code;
    } catch { /* code collision, retry */ }
  }
}

export function resolveShortLink(db, code) {
  return db.prepare('SELECT * FROM short_links WHERE code=?').get(code);
}
