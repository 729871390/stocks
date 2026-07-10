// 平台类（新闻站/聚合站）：identifier 为 feed URL。
import { discover as rssDiscover, baseNormalize, detect as rssDetect } from './rss.js';

export async function discover(source) {
  return rssDiscover(source);
}

export async function fetch(source, raw) {
  return baseNormalize(source, raw, 'article');
}

export const detect = rssDetect;
