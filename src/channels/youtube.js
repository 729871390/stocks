// YouTube：频道 RSS 发现 + yt-dlp 拉字幕（不做 ASR）。identifier = channel_id（UC 开头）。
// 用户常贴 youtube.com/@handle 链接：normalizeSource 会抓频道页解析出 channel_id 并回写（自愈）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFeed } from './rss.js';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const UC_RE = /^UC[\w-]{16,}$/;

export async function discover(source) {
  if (!UC_RE.test(source.identifier)) {
    throw new Error(`identifier 不是频道ID（UC…）："${source.identifier}"，请贴频道链接由系统解析`);
  }
  const feed = await parseFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${source.identifier}`);
  return feed.items || [];
}

export async function fetch(source, raw) {
  const videoId = (raw.id || '').replace(/^yt:video:/, '') ||
    (raw.link?.match(/[?&]v=([\w-]+)/) || [])[1];
  return {
    external_id: videoId || raw.link,
    url: raw.link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null),
    title: raw.title || null,
    text: raw.contentSnippet || raw.content || '',
    author: raw.author || null,
    published_at: raw.isoDate || raw.pubDate || null,
    content_type: 'video',
    media_urls: [],
    extra: { video_id: videoId },
  };
}

// 入库后钩子：config.transcribe=true 时用 yt-dlp 拉字幕补全正文（异步，失败不阻塞）
export async function onInserted(db, source, item) {
  const cfg = JSON.parse(source.config || '{}');
  if (!cfg.transcribe) return;
  const videoId = JSON.parse(item.extra || '{}').video_id;
  if (!videoId) return;
  try {
    const subtitle = await fetchSubtitle(videoId);
    if (subtitle) db.prepare('UPDATE items SET text=?, full_text_fetched=1 WHERE id=?').run(subtitle, item.id);
  } catch (e) {
    console.warn(`yt-dlp subtitle failed for ${videoId}: ${e.message}`);
  }
}

async function fetchSubtitle(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const { stdout } = await execFileP('yt-dlp', [
    '--skip-download', '--write-auto-subs', '--sub-langs', 'en,zh.*',
    '--sub-format', 'vtt', '-o', '-', '--quiet', url,
  ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  if (!stdout) return null;
  return stdout
    .split('\n')
    .filter(l => l && !/^\d+$/.test(l) && !l.includes('-->') && !l.startsWith('WEBVTT') && !l.startsWith('Kind:') && !l.startsWith('Language:'))
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50_000) || null;
}

// 批量/单条添加自动识别：channel_id、/channel/ 链接、@handle 链接、裸 @handle 均可
export function detect(input) {
  const s = input.trim();
  let m = s.match(/youtube\.com\/channel\/(UC[\w-]{16,})/) || s.match(/^(UC[\w-]{16,})$/);
  if (m) return { identifier: m[1] };
  m = s.match(/youtube\.com\/(@[\w.\-]+)/);
  if (m) return { identifier: m[1] }; // @handle，normalizeSource 解析为 channel_id
  return null;
}

// 从频道页 HTML 提取 channel_id 与频道名（纯函数，便于测试）
export function extractChannelFromHtml(html) {
  const id = (html.match(/"channelId"\s*:\s*"(UC[\w-]{16,})"/) ||
    html.match(/channel_id=(UC[\w-]{16,})/) ||
    html.match(/youtube\.com\/channel\/(UC[\w-]{16,})/) || [])[1];
  if (!id) return null;
  const name = (html.match(/<meta property="og:title" content="([^"]+)"/) ||
    html.match(/<title>([^<]+?)(?:\s*-\s*YouTube)?<\/title>/) || [])[1];
  return { identifier: id, name: name?.trim() || null };
}

// 抓取前规范化（fetchSource 调用并回写 DB，自愈存错的 identifier）：
// 支持 UC…（原样）、@handle、youtube.com/@handle、/channel/UC… 各种输入
export async function normalizeSource(source) {
  const raw = String(source.identifier).trim();
  if (UC_RE.test(raw)) return null;

  let m = raw.match(/(UC[\w-]{16,})/);
  let resolved = m ? { identifier: m[1], name: null } : null;

  if (!resolved) {
    let url = null;
    if (/^https?:\/\//.test(raw) && /youtube\.com/.test(raw)) url = raw.split(/[?#]/)[0];
    else if (/^@[\w.\-]+$/.test(raw)) url = `https://www.youtube.com/${raw}`;
    if (!url) throw new Error(`无法识别 YouTube 标识："${raw}"（支持频道链接 / @handle / UC 开头的频道ID）`);
    const res = await globalThis.fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { const e = new Error(`YouTube 频道页 ${res.status}`); e.status = res.status; throw e; }
    resolved = extractChannelFromHtml(await res.text());
    if (!resolved) throw new Error(`频道页中未找到 channel_id："${url}"`);
  }

  const out = { identifier: resolved.identifier };
  const namePlaceholder = source.name === source.identifier || /^https?:\/\//.test(source.name) || /^@/.test(source.name);
  if (resolved.name && namePlaceholder) out.name = resolved.name;
  return out;
}
