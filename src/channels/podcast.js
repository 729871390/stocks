import { discover as rssDiscover, baseNormalize, detect as rssDetect } from './rss.js';

export async function discover(source) {
  return rssDiscover(source);
}

export async function fetch(source, raw) {
  return baseNormalize(source, raw, 'podcast');
}

export const detect = rssDetect;
