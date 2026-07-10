import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, makeSource } from './helpers.js';
import { recordAttempt, recordSuccess, computeStatus, classifyError, isIdle } from '../src/core/sourceWriters.js';
import { normDate } from '../src/core/time.js';

function hoursAgo(n) {
  return normDate(new Date(Date.now() - n * 3600_000));
}

test('错误三分类', () => {
  assert.equal(classifyError({ status: 404 }), 'permanent');
  assert.equal(classifyError({ status: 429 }), 'ratelimit');
  assert.equal(classifyError(new Error('ETIMEDOUT socket hang up')), 'transient');
  assert.equal(classifyError(new Error('HTTP 503 unavailable')), 'transient');
  assert.equal(classifyError(new Error('account does not exist')), 'permanent');
});

test('限流不计入失败计数，只留痕', () => {
  const db = memDb();
  const s = makeSource(db);
  recordAttempt(db, s.id, { error: { status: 429, message: 'rate limited' } });
  const row = db.prepare('SELECT fail_count, last_error FROM sources WHERE id=?').get(s.id);
  assert.equal(row.fail_count, 0);
  assert.match(row.last_error, /^\[ratelimit\]/);
});

test('状态推导：permanent 立即 dead；transient 按周期推导 failing；成功即 ok', () => {
  const db = memDb();
  const s = makeSource(db);
  recordSuccess(db, s.id);
  recordAttempt(db, s.id);
  assert.equal(computeStatus(db, s.id), 'ok');

  recordAttempt(db, s.id, { error: { status: 404, message: 'gone' } });
  assert.equal(computeStatus(db, s.id), 'dead');

  // transient 失败但距上次成功超过 3 个周期（默认周期 12h）-> failing
  const s2 = makeSource(db, { identifier: 'https://example.com/f2' });
  db.prepare('UPDATE sources SET last_success_at=? WHERE id=?').run(hoursAgo(40), s2.id);
  recordAttempt(db, s2.id, { error: new Error('timeout') });
  assert.equal(computeStatus(db, s2.id), 'failing');

  // 超过 10 个周期无成功 -> dead
  db.prepare('UPDATE sources SET last_success_at=? WHERE id=?').run(hoursAgo(130), s2.id);
  assert.equal(computeStatus(db, s2.id), 'dead');

  // 从未成功且创建超 10 周期 -> dead
  const s3 = makeSource(db, { identifier: 'https://example.com/f3', created_at: hoursAgo(200) });
  assert.equal(computeStatus(db, s3.id), 'dead');
});

test('铁律：低活跃≠故障。last_new_item_at 不参与判定，只出 idle 提示', () => {
  const db = memDb();
  const s = makeSource(db);
  // 两个月没新内容但抓取成功
  db.prepare('UPDATE sources SET last_new_item_at=? WHERE id=?').run(hoursAgo(24 * 60), s.id);
  recordSuccess(db, s.id);
  recordAttempt(db, s.id);
  assert.equal(computeStatus(db, s.id), 'ok');
  const fresh = db.prepare('SELECT * FROM sources WHERE id=?').get(s.id);
  assert.equal(isIdle(fresh), true);
});

test('停用/软删除 -> paused', () => {
  const db = memDb();
  const s = makeSource(db);
  db.prepare('UPDATE sources SET enabled=0 WHERE id=?').run(s.id);
  assert.equal(computeStatus(db, s.id), 'paused');
});
