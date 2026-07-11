// 单源抓取编排：normalizeSource(自愈) -> discover -> fetch(归一化) -> insertItems -> 健康记账 -> 状态推导。
// 抓取成功即链式触发分级任务（run_once 语义由调用方入队实现）。

import { getAdapter } from '../channels/registry.js';
import { insertItems } from './ingest.js';
import { recordAttempt, recordSuccess, computeStatus, resolveSiteUrl } from './sourceWriters.js';
import { nowUtc } from './time.js';

// 抓取前规范化：适配器可将用户贴的链接解析为规范 identifier（如 youtube @handle -> UC 频道ID、
// x.com 链接 -> handle），成功后回写 DB 自愈存量错误源；唯一键冲突时仅在内存中生效。
export async function prepareSource(db, source) {
  const adapter = getAdapter(source.channel);
  if (!adapter.normalizeSource) return source;
  const norm = await adapter.normalizeSource(source); // 解析失败按抓取失败记账（由调用方捕获）
  if (!norm) return source;
  try {
    db.prepare('UPDATE sources SET identifier=COALESCE(?, identifier), name=COALESCE(?, name), updated_at=? WHERE id=?')
      .run(norm.identifier ?? null, norm.name ?? null, nowUtc(), source.id);
    if (norm.identifier) await resolveSiteUrl(db, source.id);
  } catch { /* (channel, identifier) 唯一键冲突：已有同 identifier 的源，本次仅内存生效 */ }
  return { ...source, ...norm };
}

// 首抓成功后用 feed 标题补占位名（用户批量贴链接时 name 默认=identifier）
function backfillName(db, source, raws) {
  const feedTitle = raws[0]?._feed?.title;
  if (!feedTitle) return;
  const placeholder = source.name === source.identifier || /^https?:\/\//.test(source.name);
  if (placeholder) {
    db.prepare('UPDATE sources SET name=?, updated_at=? WHERE id=?')
      .run(String(feedTitle).slice(0, 120), nowUtc(), source.id);
  }
}

export async function fetchSource(db, source) {
  try {
    source = await prepareSource(db, source);
    const adapter = getAdapter(source.channel);
    const raws = await adapter.discover(source);
    backfillName(db, source, raws);
    const normalized = [];
    for (const raw of raws) normalized.push(await adapter.fetch(source, raw));
    const result = insertItems(db, source, normalized, {
      onInserted: adapter.onInserted
        ? (d, s, item) => { adapter.onInserted(d, s, item).catch(e => console.warn(e.message)); }
        : null,
    });
    recordAttempt(db, source.id);
    recordSuccess(db, source.id);
    computeStatus(db, source.id);
    return { ok: true, discovered: raws.length, ...result };
  } catch (error) {
    const { kind } = recordAttempt(db, source.id, { error });
    computeStatus(db, source.id);
    return { ok: false, error: String(error?.message || error), errorKind: kind };
  }
}

export function activeSources(db, { channels = null } = {}) {
  let sql = `SELECT * FROM sources WHERE enabled=1 AND deleted_at IS NULL`;
  const params = [];
  if (channels) {
    sql += ` AND channel IN (${channels.map(() => '?').join(',')})`;
    params.push(...channels);
  }
  return db.prepare(sql).all(...params);
}

export async function fetchAll(db, { channels = null } = {}) {
  const sources = activeSources(db, { channels });
  const results = [];
  for (const s of sources) {
    results.push({ source: s.name, ...(await fetchSource(db, s)) });
  }
  return results;
}
