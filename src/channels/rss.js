import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 20000,
  customFields: { item: [['media:content', 'mediaContent'], ['itunes:duration', 'itunesDuration'], 'enclosure'] },
});

export async function parseFeed(url) {
  return parser.parseURL(url);
}

export async function discover(source) {
  const feed = await parseFeed(source.identifier);
  return (feed.items || []).map(it => ({ ...it, _feed: { link: feed.link, title: feed.title } }));
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

export function baseNormalize(source, raw, contentType = 'article') {
  const media = [];
  if (raw.enclosure?.url) media.push(raw.enclosure.url);
  if (raw.mediaContent?.$?.url) media.push(raw.mediaContent.$.url);
  return {
    external_id: raw.guid || raw.id || raw.link || `${source.identifier}#${raw.title}`,
    url: raw.link || null,
    title: raw.title || null,
    text: stripHtml(raw['content:encoded'] || raw.content || raw.contentSnippet || raw.summary || ''),
    author: raw.creator || raw.author || raw._feed?.title || null,
    published_at: raw.isoDate || raw.pubDate || null, // ingest 层 normDate 统一归一化
    content_type: contentType,
    media_urls: media,
    duration: parseDuration(raw.itunesDuration),
  };
}

function parseDuration(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export async function fetch(source, raw) {
  return baseNormalize(source, raw, 'article');
}

// 批量添加自动识别：URL 直接当 feed；页面 URL 探测 <link rel=alternate> 由 web 层处理
export function detect(input) {
  try {
    const u = new URL(input.trim());
    return { identifier: u.toString() };
  } catch { return null; }
}
