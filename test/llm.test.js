import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { resolveProvider, llmConfigured, toGeminiSchema } from '../src/llm/client.js';

function withEnv(env, fn) {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'LLM_PROVIDER'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const savedProvider = config.llm.provider;
  try { fn(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    config.llm.provider = savedProvider;
  }
}

test('provider 解析：auto 按已配置 key 自动选，anthropic 优先', () => {
  withEnv({}, () => {
    assert.equal(resolveProvider(), null);
    assert.equal(llmConfigured(), false);
  });
  withEnv({ GEMINI_API_KEY: 'g' }, () => {
    assert.equal(resolveProvider(), 'gemini');
  });
  withEnv({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }, () => {
    assert.equal(resolveProvider(), 'anthropic');
  });
  // 强制指定
  withEnv({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', LLM_PROVIDER: 'gemini' }, () => {
    assert.equal(resolveProvider(), 'gemini');
  });
  // 强制指定但缺 key -> 视为未配置
  withEnv({ ANTHROPIC_API_KEY: 'a', LLM_PROVIDER: 'gemini' }, () => {
    assert.equal(resolveProvider(), null);
    assert.equal(llmConfigured(), false);
  });
});

test('三档模型在两个供应商下均有定义', () => {
  for (const provider of ['anthropic', 'gemini']) {
    for (const tier of ['grading', 'main', 'light']) {
      assert.ok(config.llm.models[provider][tier], `${provider}.${tier}`);
    }
  }
});

test('Gemini schema 转换：类型大写、丢 additionalProperties、仅保留字符串枚举', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: {
      grade: { type: 'integer', enum: [1, 2, 3, 4, 5] },
      tag: { type: 'string', enum: ['a', 'b'] },
      facts: { type: 'array', items: { type: 'string' } },
    },
    required: ['grade'],
    additionalProperties: false,
  });
  assert.equal(out.type, 'OBJECT');
  assert.equal(out.additionalProperties, undefined);
  assert.equal(out.properties.grade.type, 'INTEGER');
  assert.equal(out.properties.grade.enum, undefined);   // 整数枚举不支持，丢弃
  assert.deepEqual(out.properties.tag.enum, ['a', 'b']); // 字符串枚举保留
  assert.equal(out.properties.facts.type, 'ARRAY');
  assert.equal(out.properties.facts.items.type, 'STRING');
  assert.deepEqual(out.required, ['grade']);
});
