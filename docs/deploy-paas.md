# 托管平台部署（路线 A）：Zeabur / Railway 逐步指引

不用买服务器、不用敲命令。平台从 GitHub 仓库自动构建（仓库里的 `Dockerfile` 会被自动识别），
给你一个 https 网址，发给朋友即可。全程约 15 分钟。

**先准备两样东西：**

1. **LLM key（二选一）**：
   - Gemini（推荐起步，有免费额度）：打开 [aistudio.google.com](https://aistudio.google.com) → 登录 Google 账号 → 左侧 `Get API key` → `Create API key`，复制保存（形如 `AIzaSy...`）
   - 或 Anthropic：[console.anthropic.com](https://console.anthropic.com) → API Keys → 创建（形如 `sk-ant-...`，需充值）
2. **想好两个密码**：管理密码（你自己用）、访客密码（发给朋友，只能浏览）。

---

## 方式一：Zeabur（中文界面，支持支付宝/微信支付，国内用户推荐）

费用：Developer 套餐 $5/月起按用量计（这个应用很轻，通常就在最低档）。
免费套餐会休眠，**定时抓取和日报会停跑，不要用免费档**。

1. 打开 [zeabur.com](https://zeabur.com) → 用 GitHub 账号登录（授权时允许访问 `729871390/stocks` 仓库）。
2. 控制台 → **创建项目**，区域选 **香港** 或 **新加坡**（访问 Google/Anthropic API 都通畅）。
3. 项目里 → **添加服务** → **GitHub** → 选择 `stocks` 仓库（分支保持默认）。
   Zeabur 会识别 Dockerfile 并开始构建（首次约 2-4 分钟）。
4. **挂持久盘（关键，不做这步重启就丢数据）**：
   服务卡片 → `Volumes`（存储卷）→ 添加卷 → 挂载路径填 **`/data`** → 确认（会重启服务）。
5. **填环境变量**：服务卡片 → `Variables`（变量）→ 逐个添加：

   | 变量名 | 值 |
   |---|---|
   | `ADMIN_PASSWORD` | 你的管理密码 |
   | `VIEWER_PASSWORD` | 给朋友的只读密码 |
   | `GEMINI_API_KEY` | 第 0 步拿到的 key（用 Anthropic 则填 `ANTHROPIC_API_KEY`） |

6. **生成网址**：服务卡片 → `Networking`（网络）→ `Generate Domain`，得到形如
   `https://xxx.zeabur.app` 的网址。
7. 回到 `Variables` **补一个变量**：`PUBLIC_BASE_URL` = 上一步的完整网址
   （如 `https://xxx.zeabur.app`，不带末尾斜杠），保存后服务自动重启。
8. 浏览器打开网址 → 输入管理密码登录 → **信息源页**批量粘贴你的 RSS/X/YouTube 源 →
   **系统页**填 watchlist。
9. 把 **网址 + 访客密码** 发给朋友，完成 🎉

## 方式二：Railway（英文界面，需海外信用卡）

费用：Hobby $5/月（含 $5 用量，这个应用通常用不完）。

1. [railway.com](https://railway.com) → GitHub 登录 → **New Project** → **Deploy from GitHub repo** → 选 `stocks`。
   仓库里的 `railway.json` 已配好 Dockerfile 构建、`/healthz` 健康检查与重启策略。
2. 服务 → **Settings → Volumes → Add Volume**，Mount Path 填 **`/data`**。
3. 服务 → **Variables**：添加 `ADMIN_PASSWORD`、`VIEWER_PASSWORD`、`GEMINI_API_KEY`（或 `ANTHROPIC_API_KEY`）。
4. **Settings → Networking → Generate Domain** 得到 `https://xxx.up.railway.app`。
5. Variables 补 `PUBLIC_BASE_URL` = 该网址 → 自动重新部署。
6. 打开网址登录、加源、发给朋友（同上 8-9 步）。

---

## 部署后自检清单

- [ ] 打开 `https://你的网址/healthz` 显示 `{"ok":true}`
- [ ] 未登录访问首页会跳到登录页；访客密码登录后左上导航能看到信息流/日报
- [ ] 平台日志（Zeabur: `Logs` / Railway: `Deployments → View Logs`）里能看到
      `[scheduler] 12 jobs scheduled` 和 `LLM provider: gemini`（或 anthropic）
- [ ] 管理密码登录 → 信息源页添加一个 RSS 源 → 详情弹窗点"测试抓取"能回显"连通 ok · 新入库 N 条"
- [ ] 次日早上 7:30（北京时间）后打开"日报"页应有当日日报

## 常见问题

- **重新部署/更新代码**：GitHub 仓库有新提交时平台自动重新构建；数据在 `/data` 卷里不受影响。
- **忘了挂 /data 卷**：一切正常但每次重启源和条目清零——回去补挂卷即可（之前的数据找不回）。
- **想换密码**：改环境变量重启即可，所有已登录的人自动下线。
- **备份**：Zeabur/Railway 卷各有快照/下载入口；也可以在本地
  `curl` 不了 SQLite 文件，最稳妥是平台控制台里给卷做快照。
- **LLM 报 429（额度用尽）**：Gemini 免费额度按分钟/天限速，分级任务会自动重试下一轮；
  源很多时建议升级付费档或换 `ANTHROPIC_API_KEY`。
