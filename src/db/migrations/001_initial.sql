-- 001_initial: 全量初始 schema。
-- Schema 变更三件套约定：每个后续迁移必须附带存量回填语句与 assertions.js 中的一致性断言。

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                -- rss / wechat / platform / x / youtube / podcast（应用层注册表校验，不用 DB enum）
  identifier TEXT NOT NULL,             -- 渠道内唯一标识（rss=feed URL；x=规范化 handle；youtube=channel_id）
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',    -- JSON：渠道专属参数，新渠道配置一律进这里不加列
  industry_tag TEXT,                    -- X 账号行业标签（十选一）
  role TEXT,                            -- 研究者/创始人·高管/投资人/机构官号/KOL
  priority TEXT NOT NULL DEFAULT 'P1',  -- P0 核心 / P1 标准 / P2 观察
  enabled INTEGER NOT NULL DEFAULT 1,
  -- 三时间戳语义分离：attempt=调度有没有轮到；success=链路通不通；new_item=源本身活不活跃
  last_attempt_at TEXT,                 -- 唯一写入点 recordAttempt()；NULL=从未被调度
  last_success_at TEXT,                 -- 唯一写入点 recordSuccess()；NULL=从未成功
  last_new_item_at TEXT,                -- 唯一写入点 insertItems() 事务内；NULL=库内无该源条目；回填=MAX(published_at)
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'ok',    -- 唯一写入点 computeStatus()：ok / failing / dead / paused
  site_url TEXT,                        -- 唯一写入点 resolveSiteUrl()，创建时解析一次
  notes TEXT,
  deleted_at TEXT,                      -- 软删除
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sources_channel_identifier ON sources(channel, identifier);

CREATE TABLE source_stats (
  source_id INTEGER PRIMARY KEY REFERENCES sources(id),
  items_30d INTEGER NOT NULL DEFAULT 0,
  high_grade_ratio_30d REAL,
  computed_at TEXT NOT NULL
);

CREATE TABLE source_changes (              -- 详情弹窗“最近 3 条变更记录”+ 启停/删除审计
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,            -- 源侧唯一标识，与 source_id 联合唯一，入库幂等
  url TEXT,
  canonical_url TEXT,                   -- 归一化 URL；入库前查重
  title TEXT,
  ai_title TEXT,                        -- AI 中文事件式标题（硬保证 100% 覆盖）
  text TEXT,
  author TEXT,
  published_at TEXT,                    -- UTC "YYYY-MM-DD HH:MM:SS"（入库前 normDate 强制归一化）
  fetched_at TEXT NOT NULL,             -- 抓取时间（分级窗口按此开窗，绝不按发布时间）
  content_type TEXT NOT NULL DEFAULT 'article', -- article / tweet / video / podcast
  media_urls TEXT NOT NULL DEFAULT '[]',
  duration INTEGER,
  grade INTEGER,                        -- 1-5；NULL=未分级
  category TEXT,                        -- 六栏目：model_labs / compute_infra / software_app / funding / people / research
  industry_tags TEXT NOT NULL DEFAULT '[]', -- 行业（七选一多至二）
  action_tag TEXT,                      -- 行为（十选一）
  companies TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  so_what TEXT,
  facts TEXT NOT NULL DEFAULT '[]',
  cluster_id INTEGER,                   -- 事件簇 ID（同事件折叠展示）
  hidden INTEGER NOT NULL DEFAULT 0,    -- 唯一合法用途：真重复合并后的冗余载体
  also_seen_in TEXT NOT NULL DEFAULT '[]', -- [{source_id, url}]
  grade_retries INTEGER NOT NULL DEFAULT 0, -- ≥maxRetries 止损出队
  graded_at TEXT,
  engagement INTEGER,                   -- X 互动量级（热度输入，绝不写入正文）
  full_text_fetched INTEGER NOT NULL DEFAULT 0,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_items_source_external ON items(source_id, external_id);
CREATE INDEX idx_items_canonical ON items(canonical_url);
CREATE INDEX idx_items_fetched ON items(fetched_at);
CREATE INDEX idx_items_published ON items(published_at);
CREATE INDEX idx_items_grade ON items(grade);
CREATE INDEX idx_items_cluster ON items(cluster_id);

CREATE VIRTUAL TABLE items_fts USING fts5(title, text, content='items', content_rowid='id');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, text) VALUES('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, text ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, text) VALUES('delete', old.id, old.title, old.text);
  INSERT INTO items_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TABLE cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  cron_expr TEXT NOT NULL,
  timezone TEXT NOT NULL,
  job_type TEXT NOT NULL,               -- 对应 jobs/definitions.js 中的处理函数
  payload TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  run_once INTEGER NOT NULL DEFAULT 0,  -- 触发一次后自动禁用
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (                     -- 异步任务队列（worker 消费）：初始化抓取、链式分级等
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending / running / done / failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_status_run ON tasks(status, run_at);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,            -- 存储键=生成地日期（不迁移），展示一律转目标时区
  report_type TEXT NOT NULL DEFAULT 'daily', -- daily / weekly
  title TEXT,                           -- AI 一句话标题
  content TEXT NOT NULL,                -- JSON：deep_reads / signals / sections / calendar / appendix
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_reports_date_type ON reports(report_date, report_type);

CREATE TABLE short_links (
  code TEXT PRIMARY KEY,                -- code 即凭据：免 token 可读不可枚举
  kind TEXT NOT NULL,                   -- d=日报 i=条目
  target_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_short_links_target ON short_links(kind, target_id); -- KV 幂等复用

CREATE TABLE watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL UNIQUE,
  industry TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,    -- owner 钦定：深读选择 +1000
  next_earnings_date TEXT,              -- 提醒日历 + T-1 推送
  created_at TEXT NOT NULL
);

CREATE TABLE trigger_points (            -- 深读观察点结构化登记，到期日在日报头部“触发点回访”回显
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER,
  item_id INTEGER,
  subject TEXT NOT NULL,
  criteria TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open / revisited / closed
  created_at TEXT NOT NULL
);

CREATE TABLE tweet_cache (               -- 上下文补全：tweet id 缓存一次抓取
  tweet_id TEXT PRIMARY KEY,
  payload TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE merge_preview (             -- 强合并预演清单（dryRun 期间人工抽查）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keep_item_id INTEGER NOT NULL,
  hide_item_id INTEGER NOT NULL,
  reason TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE company_catalog (          -- 公司归类增量：新出现公司按行业归类（筛选面板“公司按行业分组”消费）
  company TEXT PRIMARY KEY,
  industry TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assertion_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  ran_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
