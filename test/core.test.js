import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normDate, fmtDisplay, dateInTz, tzDayRangeUtc } from '../src/core/time.js';
import { canonicalizeUrl, normalizeHandle } from '../src/core/canonical.js';
import { titleSimilarity, longestCommonSubstring } from '../src/core/similarity.js';
import { applyCorrections } from '../src/pipeline/grade.js';
import { stripEngagement } from '../src/report/generate.js';
import { clipAtSentence } from '../src/web/routes/reports.js';

test('normDate：RFC-2822 归一化为 UTC 标准格式（时间铁律）', () => {
  assert.equal(normDate('Wed, 09 Jul 2025 14:30:00 GMT'), '2025-07-09 14:30:00');
  assert.equal(normDate('2025-07-09T14:30:00+08:00'), '2025-07-09 06:30:00');
  assert.equal(normDate('2025-07-09 06:30:00'), '2025-07-09 06:30:00'); // 已归一化视为 UTC，幂等
  assert.equal(normDate('not a date'), null);
  assert.equal(normDate(null), null);
  // 归一化后的字符串字典序 = 时间序（RFC-2822 原样入库会击穿这一点）
  assert.ok(normDate('Wed, 09 Jul 2025 14:30:00 GMT') < normDate('2025-08-01T00:00:00Z'));
});

test('展示层时间经 Intl 指定时区渲染', () => {
  assert.equal(fmtDisplay('2025-07-09 14:30:00', 'Asia/Shanghai'), '07-09 22:30');
  assert.equal(dateInTz('2025-07-09 20:00:00', 'Asia/Shanghai'), '2025-07-10');
  const { start, end } = tzDayRangeUtc('2025-07-10', 'Asia/Shanghai');
  assert.equal(start, '2025-07-09 16:00:00');
  assert.equal(end, '2025-07-10 16:00:00');
});

test('canonical URL 归一化：追踪参数/协议/尾斜杠/twitter=x', () => {
  assert.equal(
    canonicalizeUrl('http://www.example.com/a/?utm_source=x&ref=abc&id=1'),
    'https://example.com/a?id=1');
  assert.equal(
    canonicalizeUrl('https://twitter.com/foo/status/123'),
    canonicalizeUrl('https://x.com/foo/status/123/'));
  assert.equal(canonicalizeUrl('not-a-url'), null);
  assert.equal(normalizeHandle(' @Sama '), 'sama');
});

test('标题相似度与最长公共子串', () => {
  assert.ok(titleSimilarity('OpenAI 发布 GPT-5 模型', 'OpenAI发布GPT-5模型！') > 0.9);
  assert.ok(titleSimilarity('OpenAI 发布 GPT-5', '英伟达发布新芯片') < 0.5);
  assert.ok(longestCommonSubstring('OpenAI发布GPT-5重磅模型', '今日OpenAI发布GPT-5') >= 6);
});

test('分级修正规则按序执行', () => {
  // 观点封顶 3
  assert.equal(applyCorrections(5, { is_opinion: true, has_numbers: true }), 3);
  // 无数字"重大"降 1
  assert.equal(applyCorrections(5, { has_numbers: false }), 4);
  // 命中重点公司 + 核心源叠加升幅封顶 +1
  assert.equal(applyCorrections(3, { has_numbers: true, watchlist_hit: true, core_source: true }), 4);
  // 48h 重复降 2
  assert.equal(applyCorrections(4, { has_numbers: true, dup_48h: true }), 2);
  // 纯转发封顶 2
  assert.equal(applyCorrections(4, { has_numbers: true, is_pure_retweet: true }), 2);
  // 边界收敛 1..5
  assert.equal(applyCorrections(1, { dup_48h: true }), 1);
});

test('互动数据兜底剥离按句边界', () => {
  const text = 'OpenAI 发布新模型。该推文获得 12万 点赞。定价为每百万 token 5 美元。';
  const out = stripEngagement(text);
  assert.ok(!out.includes('点赞'));
  assert.ok(out.includes('定价为每百万 token 5 美元'));
});

test('句边界截断防切半句', () => {
  const s = '第一句话完整。第二句话也完整。第三句很长很长很长很长很长很长';
  const out = clipAtSentence(s, 20);
  assert.ok(out.endsWith('。'));
});
