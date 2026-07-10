// 时间铁律：任何日期入库前归一化为 UTC "YYYY-MM-DD HH:MM:SS"。
// RFC-2822 原样入库会击穿 SQLite 字典序比较（"Wed, 01 ..." > 任何 ISO 日期），
// 导致时间窗过滤恒真、排序错乱、条目集体沉底。
// 展示层统一经 Intl 按目标时区渲染，禁止浏览器/服务器本地时区直出。

export function normDate(input) {
  if (input === null || input === undefined || input === '') return null;
  let d;
  if (input instanceof Date) d = input;
  else if (typeof input === 'number') d = new Date(input);
  else {
    const s = String(input).trim();
    // 已归一化格式视为 UTC（Date.parse 会按本地时区解析无时区标记的字符串）
    const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
    d = m ? new Date(`${m[1]}T${m[2]}Z`) : new Date(s);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function nowUtc() {
  return normDate(new Date());
}

// UTC 标准串 -> Date
export function toDate(utcStr) {
  if (!utcStr) return null;
  const d = new Date(utcStr.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addHours(utcStr, hours) {
  const d = toDate(utcStr);
  return d ? normDate(new Date(d.getTime() + hours * 3600_000)) : null;
}

export function hoursBetween(aUtc, bUtc) {
  const a = toDate(aUtc); const b = toDate(bUtc);
  if (!a || !b) return null;
  return Math.abs(b.getTime() - a.getTime()) / 3600_000;
}

// 展示：强制目标时区，绝对格式“月-日 时:分”
export function fmtDisplay(utcStr, tz) {
  const d = toDate(utcStr);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// 目标时区下的日期串 YYYY-MM-DD（日报存储键、归档分组用）
export function dateInTz(dateOrUtcStr, tz) {
  const d = dateOrUtcStr instanceof Date ? dateOrUtcStr : toDate(dateOrUtcStr);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 目标时区某天 [00:00, 24:00) 对应的 UTC 区间（栏目速览等“当日”口径）
export function tzDayRangeUtc(dateStr, tz) {
  // 通过两次探测得到该时区当日零点的 UTC 偏移
  const probe = new Date(`${dateStr}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(probe, tz);
  const start = new Date(probe.getTime() - offsetMin * 60_000);
  const end = new Date(start.getTime() + 24 * 3600_000);
  return { start: normDate(start), end: normDate(end) };
}

function tzOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'));
  return (asUtc - date.getTime()) / 60_000;
}
