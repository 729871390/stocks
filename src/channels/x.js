// X：无官方 API，三层策略自动降级（config.x.strategies，默认 syndication -> nitter -> llm）：
//   syndication  官方免费旁路接口（时好时坏）
//   nitter       镜像站 RSS（config.x.nitterInstances 逐个尝试，实例列表可随时在配置里换）
//   llm          搜索型 LLM 联网抓取（设计方案预留路径；Gemini google_search / Anthropic web_search）
// 每源 config 可覆盖：{"fetchMode":"syndication|nitter|llm"} 锁定单一策略，
// 或 {"rssBridge":"https://你的桥/{handle}/rss"} 直接指定自建 RSS 桥。
// identifier = 规范化 handle（去@去空格转小写）。

import crypto from 'node:crypto';
import { normalizeHandle } from '../core/canonical.js';
import { config } from '../config.js';
import { parseFeed } from './rss.js';
import { searchText, llmConfigured } from '../llm/client.js';

const UA = 'Mozilla/5.0 (compatible; invest-info-hub/1.0)';

export async function discover(source) {
  const cfg = JSON.parse(source.config || '{}');
  const handle = source.identifier;
  if (cfg.rssBridge) {
    return fetchViaNitterFeed(cfg.rssBridge.replace('{handle}', handle), handle);
  }
  const chain = cfg.fetchMode ? [cfg.fetchMode] : (config.x?.strategies || ['syndication', 'nitter', 'llm']);
  const errors = [];
  for (const name of chain) {
    const strategy = STRATEGIES[name];
    if (!strategy) { errors.push(`${name}: 未知策略`); continue; }
    try {
      return await strategy(handle);
    } catch (e) {
      errors.push(`${name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  // 全链失败按 transient 记账（多为接口波动/镜像轮换），避免把活账号误判 dead；
  // 长期打不通仍会按周期规则推导为 dead。
  const err = new Error(`X 抓取策略全部失败 ｜ ${errors.join(' ｜ ')}`);
  err.status = 503;
  throw err;
}

const STRATEGIES = {
  syndication: fetchViaSyndication,
  nitter: fetchViaNitter,
  llm: fetchViaLlm,
};

/* ---------- 策略 1：官方 syndication 旁路 ---------- */

async function fetchViaSyndication(handle) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
  const res = await globalThis.fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) { const e = new Error(`syndication ${res.status}`); e.status = res.status; throw e; }
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('syndication payload missing __NEXT_DATA__');
  const data = JSON.parse(m[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  const tweets = entries.map(e => e?.content?.tweet).filter(Boolean);
  if (!tweets.length) throw new Error('syndication 返回空时间线');
  return tweets;
}

/* ---------- 策略 2：nitter 镜像站 RSS ---------- */

async function fetchViaNitter(handle) {
  const instances = config.x?.nitterInstances || [];
  if (!instances.length) throw new Error('未配置 nitter 实例');
  const errors = [];
  for (const base of instances) {
    try {
      const items = await fetchViaNitterFeed(`${base.replace(/\/+$/, '')}/${handle}/rss`, handle);
      if (items.length) return items;
      errors.push(`${base}: 0 条`);
    } catch (e) {
      errors.push(`${base}: ${String(e.message).slice(0, 50)}`);
    }
  }
  throw new Error(`nitter 均失败（${errors.join('，')}）`);
}

async function fetchViaNitterFeed(feedUrl, handle) {
  const feed = await parseFeed(feedUrl);
  return (feed.items || []).map(it => mapNitterItem(it, handle)).filter(Boolean);
}

// nitter RSS 条目 -> 统一 tweet 结构（纯函数，可测试）
export function mapNitterItem(it, handle) {
  const m = String(it.link || '').match(/\/status\/(\d+)/);
  if (!m) return null;
  const title = it.title || '';
  const creator = normalizeHandle(String(it.creator || it['dc:creator'] || handle));
  const isRT = /^RT by /i.test(title) || (creator && creator !== handle);
  return {
    id_str: m[1],
    full_text: it.contentSnippet || title,
    created_at: it.isoDate || it.pubDate || null,
    user: { screen_name: handle },
    ...(isRT ? { retweeted_status: {} } : {}),
  };
}

/* ---------- 策略 3：搜索型 LLM 联网抓取 ---------- */

async function fetchViaLlm(handle) {
  if (!llmConfigured()) throw new Error('llm 策略需要 GEMINI_API_KEY 或 ANTHROPIC_API_KEY');
  const n = config.x?.llmMaxTweets || 10;
  const text = await searchText({
    system: '你是精确的数据抓取器。只输出 JSON，不要任何解释、前后缀或 markdown 以外的文字。',
    prompt: `用联网搜索找出 X（Twitter）账号 @${handle} 最近发布的推文（优先最近 7 天，最多 ${n} 条）。` +
      `输出 JSON 数组，每项：{"url":"https://x.com/${handle}/status/<推文数字ID>","text":"推文原文","date":"发布时间(ISO格式)"}。` +
      `只收录确实由 @${handle} 本人发布的推文；转述、新闻报道不算。找不到任何推文就输出 []。`,
  });
  const arr = parseJsonLenient(text);
  if (!Array.isArray(arr)) throw new Error('llm 返回非数组');
  const tweets = arr.map(t => mapLlmTweet(t, handle)).filter(Boolean);
  if (!tweets.length) throw new Error('llm 搜索无结果');
  return tweets;
}

// LLM 输出 -> 统一 tweet 结构（纯函数，可测试）。无有效推文ID时用内容哈希保证幂等。
export function mapLlmTweet(t, handle) {
  if (!t || typeof t.text !== 'string' || !t.text.trim()) return null;
  const m = String(t.url || '').match(/status\/(\d{8,})/);
  const id = m ? m[1] : `llm-${crypto.createHash('sha1').update(t.text.trim()).digest('hex').slice(0, 16)}`;
  return {
    id_str: id,
    full_text: t.text.trim(),
    created_at: t.date || null,
    user: { screen_name: handle },
    _url: m ? `https://x.com/${handle}/status/${m[1]}` : null,
  };
}

// 宽松 JSON 提取：容忍 markdown 代码块与前后缀文字（纯函数，可测试）
export function parseJsonLenient(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : String(text);
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('输出中未找到 JSON');
  const close = body[start] === '[' ? ']' : '}';
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error('JSON 不完整');
  return JSON.parse(body.slice(start, end + 1));
}

/* ---------- 统一条目结构 ---------- */

export async function fetch(source, raw) {
  const id = String(raw.id_str || raw.id || '');
  const author = raw.user?.screen_name || source.identifier;
  const media = (raw.entities?.media || raw.extended_entities?.media || [])
    .map(m => m.media_url_https || m.media_url).filter(Boolean);
  const engagement = (raw.favorite_count || 0) + (raw.retweet_count || 0) * 2;
  const url = /^\d+$/.test(id) ? `https://x.com/${author}/status/${id}` : (raw._url || null);
  return {
    external_id: id,
    url,
    title: null, // 推文无标题，ai_title 由分级管道补齐
    text: raw.full_text || raw.text || '',
    author,
    published_at: raw.created_at || null,
    content_type: 'tweet',
    media_urls: media,
    engagement: engagement || null,
    extra: {
      in_reply_to_status_id: raw.in_reply_to_status_id_str || null,
      quoted_status_id: raw.quoted_status_id_str || null,
      is_retweet: Boolean(raw.retweeted_status || /^RT @/.test(raw.full_text || raw.text || '')),
      urls: (raw.entities?.urls || []).map(u => u.expanded_url).filter(Boolean),
    },
  };
}

/* ---------- 添加/自愈 ---------- */

// 抓取前规范化（fetchSource 调用并回写 DB，自愈存错的 identifier）：
// 用户常贴完整链接 https://x.com/ilyasut，这里提取出规范 handle
export async function normalizeSource(source) {
  const raw = String(source.identifier).trim();
  const d = detect(raw);
  const handle = d ? d.identifier : normalizeHandle(raw);
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new Error(`无法解析 X 用户名："${raw}"（支持 @handle 或 x.com/handle 链接）`);
  }
  const out = {};
  if (handle !== raw) out.identifier = handle;
  const namePlaceholder = source.name === source.identifier || /^https?:\/\//.test(source.name);
  if (namePlaceholder) out.name = `@${handle}`;
  return Object.keys(out).length ? out : null;
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
