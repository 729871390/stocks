// 单源抓取编排：discover -> fetch(归一化) -> insertItems -> 健康记账 -> 状态推导。
// 抓取成功即链式触发分级任务（run_once 语义由调用方入队实现）。

import { getAdapter } from '../channels/registry.js';
import { insertItems } from './ingest.js';
import { recordAttempt, recordSuccess, computeStatus } from './sourceWriters.js';

export async function fetchSource(db, source) {
  const adapter = getAdapter(source.channel);
  try {
    const raws = await adapter.discover(source);
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
