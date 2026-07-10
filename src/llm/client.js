// 模型三档（config.llm.models）：
//   grading  分级档：廉价快速模型，海量小任务（分级绝不用贵模型）
//   main     主力档：推理模型，深读成稿（adaptive thinking）
//   light    轻量档：标题、归类、摘要类 JSON 小任务
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client;
function getClient() {
  if (!client) client = new Anthropic(); // ANTHROPIC_API_KEY 从环境读取
  return client;
}

export function llmConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// JSON 任务：结构化输出保证可解析；截断（max_tokens）按错误抛出，交给重试计数止损。
export async function completeJson({ tier, system, prompt, schema }) {
  const model = config.llm.models[tier];
  const maxTokens = config.llm.maxTokens[tier];
  const params = {
    model,
    max_tokens: maxTokens, // 推理型模型 JSON 输出必须给足 max_tokens（截断是最常见的静默失败）
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  if (tier === 'main') params.thinking = { type: 'adaptive' };
  const res = await getClient().messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('llm refusal');
  if (res.stop_reason === 'max_tokens') throw new Error('llm output truncated (max_tokens)');
  const text = res.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('llm empty response');
  return JSON.parse(text);
}

export async function completeText({ tier, system, prompt }) {
  const model = config.llm.models[tier];
  const maxTokens = config.llm.maxTokens[tier];
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (tier === 'main') params.thinking = { type: 'adaptive' };
  const res = await getClient().messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('llm refusal');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('llm empty response');
  return text;
}
