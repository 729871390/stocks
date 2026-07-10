// X：无官方 API。两条路径：
//   1) config.fetchMode = "syndication"（默认）：免费旁路接口按账号拉最近推文
//   2) config.fetchMode = "llm"：搜索型 LLM（如 Grok）按账号批量抓取 —— 需在 config/local.json
//      配置 x.llm 参数后启用（本仓库预留挂点 fetchViaLlm）
// identifier = 规范化 handle（去@去空格转小写）。

import { normalizeHandle } from '../core/canonical.js';

const UA = 'Mozilla/5.0 (compatible; invest-info-hub/1.0)';

export async function discover(source) {
  const cfg = JSON.parse(source.config || '{}');
  const mode = cfg.fetchMode || 'syndication';
  if (mode === 'llm') return fetchViaLlm(source);
  return fetchViaSyndication(source.identifier);
}

async function fetchViaSyndication(handle) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
  const res = await globalThis.fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) { const e = new Error(`syndication ${res.status}`); e.status = res.status; throw e; }
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('syndication payload missing __NEXT_DATA__');
  const data = JSON.parse(m[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  return entries
    .map(e => e?.content?.tweet)
    .filter(Boolean);
}

async function fetchViaLlm() {
  // 挂点：接入搜索型 LLM 批量抓取（按账号列表一次调用），返回与 syndication 相同的 tweet 结构。
  throw new Error('x.fetchMode=llm 未配置：请在 config/local.json 提供实现所需参数');
}

export async function fetch(source, raw) {
  const id = String(raw.id_str || raw.id || '');
  const author = raw.user?.screen_name || source.identifier;
  const media = (raw.entities?.media || raw.extended_entities?.media || [])
    .map(m => m.media_url_https || m.media_url).filter(Boolean);
  const engagement = (raw.favorite_count || 0) + (raw.retweet_count || 0) * 2;
  return {
    external_id: id,
    url: `https://x.com/${author}/status/${id}`,
    title: null, // 推文无标题，ai_title 由分级管道补齐
    text: raw.full_text || raw.text || '',
    author,
    published_at: raw.created_at || null,
    content_type: 'tweet',
    media_urls: media,
    engagement,
    extra: {
      in_reply_to_status_id: raw.in_reply_to_status_id_str || null,
      quoted_status_id: raw.quoted_status_id_str || null,
      is_retweet: Boolean(raw.retweeted_status || /^RT @/.test(raw.full_text || raw.text || '')),
      urls: (raw.entities?.urls || []).map(u => u.expanded_url).filter(Boolean),
    },
  };
}

// 批量添加自动识别：提取 handle
export function detect(input) {
  const s = input.trim();
  const m = s.match(/(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/) || s.match(/^@([A-Za-z0-9_]{1,15})$/);
  if (m) {
    const h = normalizeHandle(m[1]);
    if (!['home', 'search', 'explore', 'i'].includes(h)) return { identifier: h };
  }
  if (/^[A-Za-z0-9_]{1,15}$/.test(s) && s.startsWith('@')) return { identifier: normalizeHandle(s) };
  return null;
}
