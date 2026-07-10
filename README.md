# 投资信息中台

信息源 · 信息流 · 日报 三模块流水线，按《投资信息中台设计方案 v1.0》实现。

核心理念：**一个宽进严出的信息漏斗** —— 信息源（宽进：多渠道抓全）→ 信息流（加工：去重、分级、打标、聚类，全量可检索）→ 日报（严出：每天只把最值得读的东西推到人面前）。

## 技术底座

- Node.js 22 ESM，三进程（Web 服务 / 表驱动调度器 / 异步任务 worker），pm2 托管
- SQLite 单文件（WAL）+ FTS5，免运维、原子写
- node-cron 表驱动调度（`cron_jobs` 表），每任务独立时区
- 模型三档，双供应商可选：Anthropic（分级 `claude-haiku-4-5` / 主力 `claude-opus-4-8` adaptive thinking / 轻量 `claude-haiku-4-5`）或 Google Gemini（分级 `gemini-2.5-flash` / 主力 `gemini-2.5-pro` / 轻量 `gemini-2.5-flash-lite`，有免费额度可零成本起步）。填哪个 key 用哪个，结构化输出保证 JSON 可解析

## 快速开始（本机）

```bash
npm install
export ANTHROPIC_API_KEY=...    # 或 GEMINI_API_KEY=...（aistudio.google.com 免费申请）
                                # 都不配则分级/深读自动降级跳过，其余功能可用
npm start                       # 单进程一体化（web+调度器+worker）→ http://localhost:8787

# 或分进程（pm2 三进程托管）
pm2 start ecosystem.config.cjs
```

本地覆盖配置写 `config/default.json` 同结构的 `config/local.json`（推送 webhook、阈值、时区、模型等）。

## 部署给朋友用（网页访问）

```bash
cp .env.example .env    # 填 ADMIN_PASSWORD（管理）/ VIEWER_PASSWORD（朋友只读）/ API key
docker compose up -d --build            # http://服务器IP:8787
docker compose --profile https up -d    # 有域名：自动 HTTPS（.env 填 DOMAIN）
```

- 管理密码：全部功能；访客密码：只读浏览信息流与日报（写操作 403）
- 短链 `/d/xxx` `/i/xxx` 免登录（code 即凭据），推送里的链接可直达
- 数据在 `/data/app.db` 单文件（compose 卷 `app-data`），备份即拷文件

**不想管服务器：托管平台 15 分钟上线**（Zeabur/Railway，逐步指引）见 **[docs/deploy-paas.md](docs/deploy-paas.md)**。
完整选项（云服务器 / PaaS / NAS+内网穿透、HTTPS、备份、上线清单）见 **[docs/deploy.md](docs/deploy.md)**。

## 目录结构

```
config/           默认配置（阈值/周期倍数/合并阈值全部进 config，禁止硬编码）
prompts/          分级 / 深读 / 推送压缩 / 日报标题 prompt（改文件即生效）
src/
  core/           时间铁律(normDate)、canonical、相似度、taxonomy 单点定义、
                  字段写入契约(sourceWriters)、入库运行器(ingest)、抓取编排
  channels/       渠道适配器：discover/fetch/onInserted/detect + 注册表
  pipeline/       分级(修正规则/校准告警)、聚类与强合并(dryRun 预演)、
                  X 上下文补全、全文补抓、公司归类
  report/         槽位选材、成稿(互动数据三重防线)、三路输出、短链
  jobs/           任务清单(3.8)、表驱动调度器、worker
  db/             迁移、连接、数据不变量每日自检
  web/            管理页 / 信息流 / 日报（事件委托 + data 属性，无乐观更新）
test/             核心不变量单测（node:test）
```

## 关键设计不变量（工程红线落点）

| 红线 | 落点 |
|---|---|
| 日期入库归一化 UTC `YYYY-MM-DD HH:MM:SS` | `core/time.js` normDate()，断言兜底 |
| 分级窗口按抓取时间开窗 | `pipeline/grade.js` selectQueue() |
| 分级失败 5 次止损出队 | `items.grade_retries` |
| 每个状态字段一个写入函数 | `core/sourceWriters.js` 契约注释 |
| 限流错误不计失败计数 | classifyError() 三分类 |
| 新源首抓双截断（20 条 ∩ 90 天）+ 90 天入库层全局规则 | `core/ingest.js` |
| 展示层时间 Intl 指定时区 | `core/time.js` fmtDisplay() |
| 同源标题相似度聚类只对视频/播客开放 | `pipeline/cluster.js` 规则② |
| 强合并上线前存量预演 | `merge_preview` 表 + `cluster.strongMergeDryRun`（默认 true，人工抽查后置 false） |
| 前端禁行内 handler / 禁乐观更新 | `web/public/app.js` 事件委托 |
| 推送与网页同源同规则、语义分条 | `report/push.js` |
| 低活跃 ≠ 故障 | last_new_item_at 永不参与 failing/dead 判定 |

## 渠道适配器接口

```js
discover(source) -> raw_item[]          // 发现新内容
fetch(source, raw) -> normalized_item   // {external_id, url, title, text, author,
                                        //  published_at, content_type, media_urls?, ...}
onInserted?(db, source, item)           // 入库后钩子（如 yt-dlp 拉字幕）
detect?(input) -> {identifier}|null     // 批量添加自动识别
```

新增渠道 = 一个适配器文件 + `channels/registry.js` 一行，不改任何下游代码。

X 渠道默认走 syndication 旁路接口；`config.fetchMode="llm"` 预留搜索型 LLM 批量抓取挂点（`channels/x.js`）。微信公众号经 RSS 桥（wechat2rss 等）接入。

## 定时任务（默认种子，管理页可控）

抓取两班（湾区/北京 06:30 各自本地时区）→ 链式分级 → 日报 07:30（主时区，生成前等待未分级清零 ≤15 分钟，启动补跑守卫防漏班）→ 三路输出（Web / 微信语义分条 / 飞书 post）。另有：分级兜底 2h、全文补抓 6h、财报 T-1 提醒、源统计缓存、数据不变量自检、公司归类增量、周报（周日）。

## 运维

- `npm run assertions` 手动跑不变量自检；结果在 `/admin` 展示，违反即 IM 告警（`config.push.im`）
- 分级校准线：单日 5 级 <3%、4 级 10-15%，超线写审计日志并告警——超线应收紧 5 级清单而不是放宽校准线
- 强合并启用流程：观察 `/admin` 预演清单 → 人工抽查无误伤 → `config/local.json` 置 `cluster.strongMergeDryRun=false`
