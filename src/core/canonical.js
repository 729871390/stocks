// canonical URL 归一化：去追踪参数、统一协议与尾斜杠、twitter.com=x.com。
// 指路型推文展开后必须采纳链接的 canonical，否则同链接的第二条永远合并不上。

const TRACKING_PARAMS = /^(utm_|ref$|ref_|fbclid$|gclid$|igshid$|spm$|from$|source$|si$|s$|t$|mc_cid$|mc_eid$)/;

export function canonicalizeUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.protocol = 'https:';
  u.hash = '';
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'twitter.com' || host === 'mobile.twitter.com' || host === 'mobile.x.com') host = 'x.com';
  u.hostname = host;
  if (u.port === '443' || u.port === '80') u.port = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k.toLowerCase()));
  u.search = '';
  keep.sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let s = u.toString();
  if (u.pathname === '/' && !u.search && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// X handle 规范化：去@去空格转小写
export function normalizeHandle(h) {
  return String(h || '').trim().replace(/^@/, '').toLowerCase();
}
