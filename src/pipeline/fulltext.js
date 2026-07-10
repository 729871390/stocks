// 全文补抓：正文不完整条目二次抓取（发布超 30 天不补，省外部配额）。

import { normDate, nowUtc } from '../core/time.js';
import { stripHtml } from '../channels/rss.js';

const MIN_TEXT_LEN = 300;

export async function runFullTextFetch(db, { limit = 50 } = {}) {
  const cutoff = normDate(new Date(Date.now() - 30 * 86_400_000));
  const rows = db.prepare(`SELECT id, url, text FROM items
    WHERE hidden=0 AND full_text_fetched=0 AND content_type='article'
      AND url IS NOT NULL
      AND (text IS NULL OR LENGTH(text) < ?)
      AND published_at >= ?
    LIMIT ?`).all(MIN_TEXT_LEN, cutoff, limit);
  let fetched = 0;
  for (const row of rows) {
    try {
      const res = await globalThis.fetch(row.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; invest-info-hub/1.0)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const html = await res.text();
      const body = extractArticle(html);
      if (body && body.length > (row.text || '').length) {
        db.prepare('UPDATE items SET text=?, full_text_fetched=1 WHERE id=?').run(body.slice(0, 50_000), row.id);
        fetched++;
      } else {
        db.prepare('UPDATE items SET full_text_fetched=1 WHERE id=?').run(row.id);
      }
    } catch {
      db.prepare('UPDATE items SET full_text_fetched=1 WHERE id=?').run(row.id); // 不无限重试
    }
  }
  return fetched;
}

function extractArticle(html) {
  const m = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i)
    || html.match(/<body[\s\S]*?<\/body>/i);
  return stripHtml(m ? m[0] : html);
}
