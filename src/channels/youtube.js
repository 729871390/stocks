// YouTube：频道 RSS 发现 + yt-dlp 拉字幕（不做 ASR）。identifier = channel_id。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFeed } from './rss.js';

const execFileP = promisify(execFile);

export async function discover(source) {
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

// 批量添加自动识别：YouTube 链接解析 channel_id
export function detect(input) {
  const s = input.trim();
  const m = s.match(/youtube\.com\/channel\/(UC[\w-]{20,})/) || s.match(/^(UC[\w-]{20,})$/);
  if (m) return { identifier: m[1] };
  return null;
}
