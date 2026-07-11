// 端到端 UI 测试：本地 fixture 数据 + 无头 Chromium 驱动真实页面。
// 覆盖：登录流、源管理（卡片/弹窗/测试抓取/添加）、信息流（chip 筛选/应用/低等级折叠/详情）、
// 日报页、系统页。任何页面 JS 报错即失败。
// 运行：node scripts/e2e.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 8799;
const FEED_PORT = 9912;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'e2e-admin';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iih-e2e-'));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

/* ---------- fixture feed ---------- */
const now = Date.now();
const item = (i, h, title) => `
  <item><title>${title}</title>
  <link>http://127.0.0.1:${FEED_PORT}/story/${i}</link><guid>story-${i}</guid>
  <pubDate>${new Date(now - h * 3600_000).toUTCString()}</pubDate>
  <description>正文 ${i}：定价每百万 token 5 美元。</description></item>`;
const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>E2E Wire</title><link>http://127.0.0.1:${FEED_PORT}</link>
  ${item(1, 2, 'OpenAI 发布 GPT-5 新模型')}${item(2, 5, '英伟达公布 B300 芯片售价')}
  ${item(3, 8, '某KOL无数据感想一则')}</channel></rss>`;
const feedServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/rss+xml' });
  res.end(rss);
}).listen(FEED_PORT);

/* ---------- app ---------- */
const app = spawn('node', ['src/main.js'], {
  env: {
    ...process.env, PORT: String(PORT), APP_DATA_DIR: dataDir,
    ADMIN_PASSWORD: ADMIN, VIEWER_PASSWORD: 'e2e-view',
    ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', LLM_PROVIDER: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stderr.on('data', d => process.stderr.write(`[app] ${d}`));

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('app boot timeout')), 15000);
  const poll = setInterval(() => {
    http.get(`${BASE}/healthz`, res => {
      if (res.statusCode === 200) { clearTimeout(t); clearInterval(poll); resolve(); }
    }).on('error', () => {});
  }, 300);
});

/* ---------- browser ---------- */
process.on('exit', () => { try { app.kill(); } catch {} try { feedServer.close(); } catch {} });
let browser;
const jsErrors = [];

try {
  browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {},
  );
  const page = await browser.newPage();
  page.on('pageerror', e => jsErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') jsErrors.push(m.text()); });
  // 1. 未登录跳转登录页
  await page.goto(`${BASE}/items`);
  check('未登录访问跳转登录页', page.url().includes('/login'));

  // 2. 登录
  await page.fill('input[name=password]', ADMIN);
  await page.click('button[type=submit]');
  await page.waitForURL('**/items*');
  check('管理密码登录成功', true);

  // 3. 空库提示
  check('空库提示引导去加源', (await page.textContent('body')).includes('先到'));

  // 4. 源管理：添加弹窗 -> 单条添加 fixture 源
  await page.goto(`${BASE}/sources`);
  await page.click('[data-action=open-add]');
  await page.waitForSelector('#add-single', { state: 'visible' });
  check('添加弹窗打开', true);
  await page.selectOption('#add-single select[name=channel]', 'rss');
  await page.fill('#add-single input[name=identifier]', `http://127.0.0.1:${FEED_PORT}/feed.xml`);
  await page.click('#add-single button[type=submit]');
  await page.waitForSelector('.source-card', { timeout: 10000 });
  check('源卡片出现', true);

  // 5. 源详情弹窗 + 测试抓取（真实拉 fixture 数据入库）
  await page.click('.source-card .name');   // 点名字区域（非链接部分）
  await page.click('.source-card');
  await page.waitForSelector('[data-action=test-fetch]');
  await page.click('[data-action=test-fetch]');
  await page.waitForFunction(() =>
    document.querySelector('#test-fetch-result')?.textContent.includes('连通 ok'), { timeout: 15000 });
  const testMsg = await page.textContent('#test-fetch-result');
  check('测试抓取回显', testMsg.includes('新入库'), testMsg.trim());
  await page.click('[data-action=close-modal]');

  // 6. 首抓后源名应回填为 feed 标题（init 任务或 test-fetch prepareSource）
  //    （名字回填走 fetchSource；test-fetch 不回填名字，此处触发一次 init 任务等价调用）
  // 7. 手工分级模拟（LLM 未配置），验证信息流筛选/折叠
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'app.db'));
  db.prepare(`UPDATE items SET grade=5, ai_title=title, category='model_labs',
    industry_tags='["AI Labs"]', companies='["OpenAI"]', action_tag='模型发布',
    graded_at=datetime('now') WHERE title LIKE '%OpenAI%'`).run();
  db.prepare(`UPDATE items SET grade=4, ai_title=title, category='compute_infra',
    industry_tags='["半导体"]', companies='["英伟达"]', action_tag='产品发布',
    graded_at=datetime('now') WHERE title LIKE '%英伟达%'`).run();
  db.prepare(`UPDATE items SET grade=2, ai_title=title, category='software_app',
    industry_tags='["其他"]', companies='[]', action_tag='观点评论',
    graded_at=datetime('now') WHERE title LIKE '%KOL%'`).run();
  db.close();

  // 8. 信息流：3 级以上展开、低等级折叠为一行
  await page.goto(`${BASE}/items`);
  let bodyText = await page.textContent('body');
  check('高等级条目可见', bodyText.includes('OpenAI 发布 GPT-5 新模型'));
  check('低等级折叠行出现', bodyText.includes('另有 1 条低等级条目'));
  const lowVisibleBefore = await page.isVisible('text=某KOL无数据感想一则');
  await page.click('.collapse-line');
  const lowVisibleAfter = await page.isVisible('text=某KOL无数据感想一则');
  check('点击展开低等级条目', !lowVisibleBefore && lowVisibleAfter);

  // 9. 筛选：点 5 级 chip -> 应用 -> URL 带参数且只剩 5 级条目
  const chip5 = page.locator('.chip[data-filter=grade][data-value="5"]');
  await chip5.click();
  const chipOn = await chip5.evaluate(el => el.classList.contains('on'));
  check('chip 点击高亮（staged）', chipOn);
  await page.click('[data-action=apply-filters]');
  await page.waitForURL('**/items?*');
  check('应用后 URL 带筛选参数', page.url().includes('grade=5'), page.url());
  bodyText = await page.textContent('body');
  check('筛选后只剩 5 级条目',
    bodyText.includes('OpenAI 发布 GPT-5 新模型') && !bodyText.includes('英伟达公布 B300 芯片售价'));
  check('筛选状态回显在 chip 上', await chip5.evaluate(el => el.classList.contains('on')));

  // 10. 搜索 LIKE（先取消上一步的 5 级筛选——staged 状态从 URL 回显，需显式关掉）
  await chip5.click();
  check('chip 再点一次取消高亮', !(await chip5.evaluate(el => el.classList.contains('on'))));
  await page.fill('input[name=q]', '英伟达');
  await page.click('[data-action=apply-filters]');
  await page.waitForURL('**/items?*');
  bodyText = await page.textContent('body');
  check('标题搜索命中', bodyText.includes('英伟达公布 B300 芯片售价') && !bodyText.includes('GPT-5'));

  // 11. 条目详情页
  await page.click('.item-row .title a');
  await page.waitForSelector('.detail');
  check('详情页渲染（含查看原文）', (await page.textContent('.detail')).includes('查看原文'));

  // 12. 日报页 + 系统页
  await page.goto(`${BASE}/reports`);
  check('日报列表页打开', (await page.textContent('body')).length > 0);
  await page.goto(`${BASE}/admin`);
  bodyText = await page.textContent('body');
  check('系统页显示定时任务', bodyText.includes('定时任务'));

  // 13. 访客只读
  await page.goto(`${BASE}/logout`);
  await page.fill('input[name=password]', 'e2e-view');
  await page.click('button[type=submit]');
  await page.waitForURL('**/*');
  await page.goto(`${BASE}/sources`);
  const resp = await page.evaluate(async () => {
    const r = await fetch('/api/sources/1/toggle', { method: 'POST' });
    return r.status;
  });
  check('访客写操作被拒（403）', resp === 403, `HTTP ${resp}`);

  // 14. 全程无 JS 报错（排除第 13 步故意触发的 403 资源日志）
  const realErrors = jsErrors.filter(e => !e.includes('403 (Forbidden)'));
  check('全程无页面 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (e) {
  failures++;
  console.error('❌ E2E 异常：', e.message);
  console.error(e.stack?.split('\n').slice(0, 4).join('\n'));
} finally {
  if (browser) await browser.close().catch(() => {});
  app.kill();
  feedServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nE2E 全部通过 ✅' : `\nE2E 失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
