// 模型三档（config.llm.models[provider]）：
//   grading  分级档：廉价快速模型，海量小任务（分级绝不用贵模型）
//   main     主力档：推理模型，深读成稿
//   light    轻量档：标题、归类、摘要类 JSON 小任务
// 双供应商：anthropic（默认）/ gemini（有免费额度，适合零成本跑）。
// provider="auto" 时按已配置的 key 自动选：ANTHROPIC_API_KEY 优先，其次 GEMINI_API_KEY。
// 环境变量 LLM_PROVIDER=anthropic|gemini 可强制指定。

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let anthropicClient;
function getAnthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic(); // key 从环境读取
  return anthropicClient;
}

export function resolveProvider() {
  const p = process.env.LLM_PROVIDER || config.llm.provider || 'auto';
  if (p === 'anthropic') return hasAnthropicKey() ? 'anthropic' : null;
  if (p === 'gemini') return hasGeminiKey() ? 'gemini' : null;
  // auto
  if (hasAnthropicKey()) return 'anthropic';
  if (hasGeminiKey()) return 'gemini';
  return null;
}

function hasAnthropicKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function llmConfigured() {
  return resolveProvider() !== null;
}

function tierParams(tier) {
  const provider = resolveProvider();
  return {
    provider,
    model: config.llm.models[provider][tier],
    maxTokens: config.llm.maxTokens[tier],
  };
}

// JSON 任务：结构化输出保证可解析；截断（max_tokens）按错误抛出，交给重试计数止损。
export async function completeJson({ tier, system, prompt, schema }) {
  const { provider, model, maxTokens } = tierParams(tier);
  const text = provider === 'gemini'
    ? await geminiCall({ model, maxTokens, system, prompt, schema })
    : await anthropicCall({ tier, model, maxTokens, system, prompt, schema });
  return JSON.parse(text);
}

export async function completeText({ tier, system, prompt }) {
  const { provider, model, maxTokens } = tierParams(tier);
  return provider === 'gemini'
    ? geminiCall({ model, maxTokens, system, prompt })
    : anthropicCall({ tier, model, maxTokens, system, prompt });
}

/* ---------------- Anthropic ---------------- */

async function anthropicCall({ tier, model, maxTokens, system, prompt, schema }) {
  const params = {
    model,
    max_tokens: maxTokens, // 推理型模型 JSON 输出必须给足 max_tokens（截断是最常见的静默失败）
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (schema) params.output_config = { format: { type: 'json_schema', schema } };
  if (tier === 'main') params.thinking = { type: 'adaptive' };
  const res = await getAnthropic().messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('llm refusal');
  if (res.stop_reason === 'max_tokens') throw new Error('llm output truncated (max_tokens)');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('llm empty response');
  return text;
}

/* ---------------- Gemini（REST，无需额外依赖） ---------------- */

// Gemini responseSchema 是 OpenAPI 子集：类型大写、不支持 additionalProperties、枚举仅限字符串
export function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.enum && s.type === 'string') out.enum = s.enum;
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toGeminiSchema(v);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

async function geminiCall({ model, maxTokens, system, prompt, schema }) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(schema ? {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(schema),
      } : {}),
    },
  };
  const res = await globalThis.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const e = new Error(`gemini ${res.status}: ${detail.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const cand = j.candidates?.[0];
  if (!cand) {
    const reason = j.promptFeedback?.blockReason;
    throw new Error(reason ? `llm refusal (${reason})` : 'llm empty candidates');
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('llm output truncated (max_tokens)');
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(cand.finishReason)) throw new Error('llm refusal');
  const text = (cand.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('llm empty response');
  return text;
}
