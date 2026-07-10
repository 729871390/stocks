# 部署指南：让朋友们直接打开网页用

目标形态：系统跑在一台常开的服务器上，你和朋友在任何电脑/手机浏览器输入网址即可访问。
你持有 **管理密码**（管源、管任务），朋友用 **访客密码**（只读浏览信息流与日报）。
日报推送里的短链（`/d/xxx`、`/i/xxx`）免密码直达，方便微信/飞书里点开。

## 方案 A：云服务器 + Docker（推荐，约 30-60 元/月）

任何一台能装 Docker 的 Linux 服务器都行（阿里云/腾讯云轻量应用服务器、AWS Lightsail 等，
1核 1G 即够；SQLite 单文件无需数据库服务）。

```bash
# 1. 服务器上装 Docker（官方脚本）
curl -fsSL https://get.docker.com | sh

# 2. 拉代码
git clone https://github.com/729871390/stocks.git && cd stocks

# 3. 配置
cp .env.example .env
vi .env   # 填 ADMIN_PASSWORD / VIEWER_PASSWORD / ANTHROPIC_API_KEY / PUBLIC_BASE_URL

# 4. 启动
docker compose up -d --build

# 5. 浏览器打开 http://服务器IP:8787 ，输入密码即可
```

> LLM 二选一：`ANTHROPIC_API_KEY`，或 `GEMINI_API_KEY`（在 aistudio.google.com 免费申请，
> 有免费额度，轻量使用可零成本）。国内机房访问这两家 API 都可能需要出网代理
> （给容器加 `HTTPS_PROXY` 环境变量即可）。

### 加域名与 HTTPS（可选但建议）

把域名 A 记录解析到服务器 IP，然后：

```bash
# .env 里补：
#   DOMAIN=info.example.com
#   PUBLIC_BASE_URL=https://info.example.com
docker compose --profile https up -d
```

Caddy 会自动申请与续期证书，朋友访问 `https://info.example.com`。
（此时安全组只需开放 80/443，可以关掉 8787 的公网入口。）

### 日常运维

```bash
docker compose logs -f app          # 看日志
docker compose up -d --build        # 更新代码后重建
docker compose exec app node src/db/assertions.js   # 手动跑数据自检
# 备份：数据全在 app-data 卷的 /data/app.db 单文件
docker compose cp app:/data/app.db ./backup-$(date +%F).db
```

## 方案 B：PaaS 平台（不想管服务器，推荐）

**逐步图文指引见 [deploy-paas.md](deploy-paas.md)**（Zeabur 中文界面支持支付宝；Railway 需海外信用卡）。要点：

1. 平台里从 GitHub 导入本仓库（自动识别 `Dockerfile`；Railway 另有 `railway.json` 预配置）；
2. 环境变量填 `ADMIN_PASSWORD`、`VIEWER_PASSWORD`、`GEMINI_API_KEY` 或 `ANTHROPIC_API_KEY`、`PUBLIC_BASE_URL`（填平台分配的域名）；
3. **必须挂一个持久卷到 `/data`**（SQLite 数据库在这里，不挂卷重启即丢数据）；
4. 平台给的 https 域名发给朋友即可。

> 注意选择"常驻运行"而非"按请求唤醒/免费休眠"的套餐——抓取/分级/日报靠进程内定时任务，休眠了就不跑了。

## 方案 C：家里电脑/NAS + 内网穿透（零成本私享）

在自己常开的电脑或 NAS 上 `docker compose up -d`，再用 Tailscale（组网，朋友装客户端）
或 Cloudflare Tunnel（免公网 IP 暴露成 https 网址）分享出去。适合三五个朋友的小圈子。

## 不用 Docker 的裸跑方式

```bash
git clone ... && cd stocks && npm install
ADMIN_PASSWORD=xxx VIEWER_PASSWORD=yyy ANTHROPIC_API_KEY=sk-... \
PUBLIC_BASE_URL=http://IP:8787 npm start        # 单进程一体化（web+调度+worker）
# 或 pm2 三进程：pm2 start ecosystem.config.cjs
```

## 权限模型速查

| 能力 | 管理密码 | 访客密码 | 无密码（短链） |
|---|---|---|---|
| 浏览信息流 / 日报 / 系统页 | ✅ | ✅ | — |
| 短链 /d/xxx /i/xxx | ✅ | ✅ | ✅（code 即凭据） |
| 添加/启停/删除信息源、跑任务、改 watchlist | ✅ | ❌（403） | ❌ |

两个密码都不设置时视为本机开发模式，完全开放——**公网部署务必设置 ADMIN_PASSWORD**。

## 上线后第一天要做的事

1. 用管理密码登录 → 信息源页 → 批量粘贴你的 RSS/X/YouTube/播客源；
2. 系统页 → 把 watchlist（重点公司+财报日+钉选）填上；
3. 等一两天分级积累后，看系统页"强合并预演清单"，抽查无误伤 → 在服务器上给
   `config/local.json` 写 `{"cluster":{"strongMergeDryRun":false}}` 并重启，开启强合并；
4. 想要微信/飞书推送：`config/local.json` 里填 `push.wechat.webhook` / `push.feishu.webhook`
   并把 `enabled` 置 true（企业微信群机器人 / 飞书自定义机器人的 webhook 均可）。
