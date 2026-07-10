// 字段写入契约：每个状态字段有且只有一个写入函数，其他代码路径禁止直写。
//   last_attempt_at / fail_count / last_error -> recordAttempt()
//   last_success_at                           -> recordSuccess()
//   status                                    -> computeStatus()
//   site_url                                  -> resolveSiteUrl()
//   last_new_item_at                          -> ingest.js insertItems()（事务内）

import { config } from '../config.js';
import { nowUtc, toDate } from './time.js';

// 错误三分类：permanent 立即 dead；transient 计入 fail_count；ratelimit 不计数只留痕
export function classifyError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status ?? err?.statusCode ?? (msg.match(/\b(\d{3})\b/) || [])[1];
  const code = Number(status);
  if (code === 429) return 'ratelimit';
  if ([400, 401, 403, 404, 410].includes(code)) return 'permanent';
  if (/not\s*found|gone|account.*(suspend|not exist)|invalid.*(credential|token|key)/i.test(msg)) return 'permanent';
  if (/rate.?limit|too many requests/i.test(msg)) return 'ratelimit';
  return 'transient';
}

function periodHours(source) {
  const cfg = JSON.parse(source.config || '{}');
  return Number(cfg.periodHours) || config.health.defaultPeriodHours;
}

// 每次抓取尝试结束时写（无论成败）。成功清零；transient +1；限流不计数只留痕；permanent 前缀标记。
export function recordAttempt(db, sourceId, { error = null } = {}) {
  const now = nowUtc();
  if (!error) {
    db.prepare(`UPDATE sources SET last_attempt_at=?, fail_count=0, last_error=NULL, updated_at=? WHERE id=?`)
      .run(now, now, sourceId);
    return { kind: null };
  }
  const kind = classifyError(error);
  const msg = String(error?.message || error).slice(0, 500);
  if (kind === 'transient') {
    db.prepare(`UPDATE sources SET last_attempt_at=?, fail_count=fail_count+1, last_error=?, updated_at=? WHERE id=?`)
      .run(now, msg, now, sourceId);
  } else if (kind === 'ratelimit') {
    db.prepare(`UPDATE sources SET last_attempt_at=?, last_error=?, updated_at=? WHERE id=?`)
      .run(now, `[ratelimit] ${msg}`, now, sourceId);
  } else {
    db.prepare(`UPDATE sources SET last_attempt_at=?, last_error=?, updated_at=? WHERE id=?`)
      .run(now, `[permanent] ${msg}`, now, sourceId);
  }
  return { kind };
}

// 尝试成功即写，0 条新内容也更新。
export function recordSuccess(db, sourceId) {
  const now = nowUtc();
  db.prepare(`UPDATE sources SET last_success_at=?, updated_at=? WHERE id=?`).run(now, now, sourceId);
}

// 状态按“错误类型 + 距上次成功的时长（以该源抓取周期为单位）”推导，不按固定失败次数。
// 铁律：低活跃 ≠ 故障。last_new_item_at 永不参与 failing/dead 判定。
export function computeStatus(db, sourceId, at = nowUtc()) {
  const s = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!s) return null;
  let status;
  if (!s.enabled || s.deleted_at) {
    status = 'paused';
  } else {
    const ph = periodHours(s);
    const nowMs = toDate(at).getTime();
    const sinceSuccessPeriods = s.last_success_at
      ? (nowMs - toDate(s.last_success_at).getTime()) / 3600_000 / ph
      : null;
    const sinceCreatedPeriods = (nowMs - toDate(s.created_at).getTime()) / 3600_000 / ph;
    const isPermanent = (s.last_error || '').startsWith('[permanent]');
    const { failingPeriods, deadPeriods } = config.health;
    if (isPermanent) status = 'dead';
    else if (sinceSuccessPeriods !== null && sinceSuccessPeriods > deadPeriods) status = 'dead';
    else if (sinceSuccessPeriods === null && sinceCreatedPeriods > deadPeriods) status = 'dead';
    else if (s.fail_count > 0 && sinceSuccessPeriods !== null && sinceSuccessPeriods > failingPeriods) status = 'failing';
    else status = 'ok';
  }
  db.prepare('UPDATE sources SET status=?, updated_at=? WHERE id=?').run(status, nowUtc(), sourceId);
  return status;
}

// 超 idleDays 无新内容只出灰色 idle 提示徽标，不进故障统计（展示层用，不写库）
export function isIdle(source, at = nowUtc()) {
  if (!source.last_new_item_at) return false;
  const days = (toDate(at).getTime() - toDate(source.last_new_item_at).getTime()) / 86_400_000;
  return days > config.health.idleDays;
}

// 人类可读主页（feed <link> 或 origin），创建时解析一次
export async function resolveSiteUrl(db, sourceId, hint = null) {
  const s = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!s) return null;
  let site = hint;
  if (!site) {
    try {
      if (s.channel === 'x') site = `https://x.com/${s.identifier}`;
      else if (s.channel === 'youtube') site = `https://www.youtube.com/channel/${s.identifier}`;
      else site = new URL(s.identifier).origin;
    } catch { site = null; }
  }
  if (site) db.prepare('UPDATE sources SET site_url=?, updated_at=? WHERE id=?').run(site, nowUtc(), sourceId);
  return site;
}

export function logSourceChange(db, sourceId, action, detail = null) {
  db.prepare('INSERT INTO source_changes (source_id, action, detail, created_at) VALUES (?,?,?,?)')
    .run(sourceId, action, detail, nowUtc());
  db.prepare('INSERT INTO audit_log (entity, entity_id, action, detail, created_at) VALUES (?,?,?,?,?)')
    .run('source', String(sourceId), action, detail, nowUtc());
}
