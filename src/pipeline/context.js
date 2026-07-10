// X 上下文补全（0 模型 token）：回复/引用缺原文、thread 片段、短文本含指代 触发，
// 用免费旁路接口（cdn.syndication.twimg.com -> fxtwitter）拉父推+根推（最多 2 跳），
// thread 同作者合并为单条，补全后再进分级。tweet id 缓存一次抓取。

import { nowUtc } from '../core/time.js';

const DEIXIS_RE = /(这|那|此|上面|以下|如下|it|this|that|these|those)/i;

export function needsContext(item) {
  if (item.content_type !== 'tweet') return false;
  const extra = JSON.parse(item.extra || '{}');
  if (extra.context_done) return false;
  if (extra.in_reply_to_status_id) return true;   // 回复缺原文
  if (extra.quoted_status_id) return true;        // 引用缺原文
  const text = item.text || '';
  if (text.length < 60 && DEIXIS_RE.test(text)) return true; // 短文本含指代
  if (/^\d+[/／]\d*/.test(text.trim())) return true;          // thread 片段（"2/5"式开头）
  return false;
}

export async function fetchTweet(db, tweetId) {
  const cached = db.prepare('SELECT payload FROM tweet_cache WHERE tweet_id=?').get(tweetId);
  if (cached) return cached.payload ? JSON.parse(cached.payload) : null;
  let data = null;
  try {
    data = await fetchSyndication(tweetId);
  } catch { /* fall through */ }
  if (!data) {
    try { data = await fetchFxTwitter(tweetId); } catch { /* both failed */ }
  }
  db.prepare('INSERT OR REPLACE INTO tweet_cache (tweet_id, payload, fetched_at) VALUES (?,?,?)')
    .run(tweetId, data ? JSON.stringify(data) : null, nowUtc());
  return data;
}

async function fetchSyndication(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en`;
  const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`syndication ${res.status}`);
  const j = await res.json();
  return {
    id,
    text: j.text || '',
    author: j.user?.screen_name || '',
    in_reply_to: j.in_reply_to_status_id_str || null,
    quoted: j.quoted_tweet?.id_str || null,
  };
}

async function fetchFxTwitter(id) {
  const url = `https://api.fxtwitter.com/status/${id}`;
  const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`fxtwitter ${res.status}`);
  const j = await res.json();
  const t = j.tweet || {};
  return {
    id,
    text: t.text || '',
    author: t.author?.screen_name || '',
    in_reply_to: t.replying_to_status || null,
    quoted: t.quote?.id || null,
  };
}

export async function completeContext(db, item) {
  const extra = JSON.parse(item.extra || '{}');
  const parts = [];
  // 最多 2 跳：父推 -> 根推
  let hopId = extra.in_reply_to_status_id || extra.quoted_status_id;
  for (let hop = 0; hop < 2 && hopId; hop++) {
    const t = await fetchTweet(db, hopId);
    if (!t) break;
    parts.unshift(`@${t.author}: ${t.text}`);
    hopId = t.in_reply_to || t.quoted;
  }
  if (parts.length) {
    const merged = `${parts.map(p => `[上文] ${p}`).join('\n')}\n[本条] ${item.text || ''}`;
    db.prepare('UPDATE items SET text=? WHERE id=?').run(merged, item.id);
  }
  extra.context_done = true;
  db.prepare('UPDATE items SET extra=? WHERE id=?').run(JSON.stringify(extra), item.id);
  return parts.length;
}

// 分级前批量补全（对未分级的 tweet 跑一遍）
export async function runContextCompletion(db, { limit = 100 } = {}) {
  const rows = db.prepare(`SELECT * FROM items
    WHERE content_type='tweet' AND grade IS NULL AND hidden=0 LIMIT ?`).all(limit);
  let done = 0;
  for (const item of rows) {
    if (!needsContext(item)) continue;
    try { await completeContext(db, item); done++; } catch (e) {
      console.warn(`context completion failed item=${item.id}: ${e.message}`);
    }
  }
  return done;
}
