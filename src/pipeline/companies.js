// 公司归类增量：条目中新出现的公司按行业归类（轻量档批量），供筛选面板“公司按行业分组”。

import { INDUSTRY_TAGS } from '../core/taxonomy.js';
import { nowUtc } from '../core/time.js';
import { completeJson, llmConfigured } from '../llm/client.js';

export async function catalogNewCompanies(db) {
  const rows = db.prepare(`SELECT DISTINCT companies FROM items WHERE companies != '[]'`).all();
  const known = new Set(db.prepare('SELECT company FROM company_catalog').all().map(r => r.company));
  const fresh = new Set();
  for (const r of rows) for (const c of JSON.parse(r.companies)) if (!known.has(c)) fresh.add(c);
  if (!fresh.size) return { added: 0 };

  const list = [...fresh].slice(0, 100);
  let mapping = {};
  if (llmConfigured()) {
    try {
      const out = await completeJson({
        tier: 'light',
        system: `将公司按行业归类。可选行业：${INDUSTRY_TAGS.join(' / ')}。输出 JSON。`,
        prompt: list.join('\n'),
        schema: {
          type: 'object',
          properties: {
            companies: {
              type: 'array',
              items: {
                type: 'object',
                properties: { company: { type: 'string' }, industry: { type: 'string', enum: INDUSTRY_TAGS } },
                required: ['company', 'industry'],
                additionalProperties: false,
              },
            },
          },
          required: ['companies'],
          additionalProperties: false,
        },
      });
      for (const c of out.companies) mapping[c.company] = c.industry;
    } catch (e) {
      console.warn(`company catalog llm failed: ${e.message}`);
    }
  }
  const insert = db.prepare('INSERT OR IGNORE INTO company_catalog (company, industry, created_at) VALUES (?,?,?)');
  const txn = db.transaction(() => {
    for (const c of list) insert.run(c, mapping[c] || null, nowUtc());
  });
  txn();
  return { added: list.length };
}
