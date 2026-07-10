// 微信公众号：无公开 API，identifier 为 RSS 桥（如 wechat2rss / werss）产出的 feed URL。
import { discover as rssDiscover, baseNormalize, detect as rssDetect } from './rss.js';

export async function discover(source) {
  return rssDiscover(source);
}

export async function fetch(source, raw) {
  return baseNormalize(source, raw, 'article');
}

export const detect = rssDetect;
