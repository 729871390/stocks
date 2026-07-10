// 访问控制：共享密码登录，两种角色。
//   admin  —— 管理密码：全部功能（源管理、任务、watchlist 等写操作）
//   viewer —— 访客密码：只读浏览（信息流/日报），所有写 API 拒绝
// 未配置任何密码时不启用认证（本机开发模式）。
// 短链 /d/<code> /i/<code> 免登录（设计方案：code 即凭据，可读不可枚举），
// 方便推送里的链接直达。

import crypto from 'node:crypto';
import { config } from '../config.js';
import { layout, esc } from './layout.js';

export function authEnabled() {
  return Boolean(config.auth.adminPassword || config.auth.viewerPassword);
}

function secret() {
  if (config.auth.sessionSecret) return config.auth.sessionSecret;
  // 未显式配置时从密码派生（改密码即全员下线）
  return crypto.createHash('sha256')
    .update(`iih:${config.auth.adminPassword}:${config.auth.viewerPassword}`)
    .digest('hex');
}

function hmac(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function signSession(role, days = config.auth.sessionDays) {
  const payload = `${role}.${Date.now() + days * 86_400_000}`;
  return `${Buffer.from(payload).toString('base64url')}.${hmac(payload)}`;
}

export function verifySession(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = Buffer.from(token.slice(0, dot), 'base64url').toString();
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  if (sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [role, exp] = payload.split('.');
  if (!['admin', 'viewer'].includes(role)) return null;
  if (Number(exp) < Date.now()) return null;
  return role;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const OPEN_PREFIXES = ['/login', '/logout', '/healthz', '/public/', '/d/', '/i/'];

export function authMiddleware(req, res, next) {
  if (!authEnabled()) { req.role = 'admin'; return next(); }
  if (OPEN_PREFIXES.some(p => req.path === p.replace(/\/$/, '') || req.path.startsWith(p))) return next();
  const role = verifySession(parseCookies(req).session);
  if (!role) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录' });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  req.role = role;
  // viewer 只读：拒绝一切写操作
  if (role === 'viewer' && req.method !== 'GET') {
    return res.status(403).json({ error: '只读账号，无操作权限' });
  }
  next();
}

export function matchPassword(password) {
  const p = String(password || '');
  if (!p) return null;
  if (config.auth.adminPassword && safeEqual(p, config.auth.adminPassword)) return 'admin';
  if (config.auth.viewerPassword && safeEqual(p, config.auth.viewerPassword)) return 'viewer';
  return null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function registerAuthRoutes(app) {
  app.get('/login', (req, res) => {
    if (!authEnabled()) return res.redirect('/');
    res.send(layout({
      title: '登录',
      body: `
      <div class="modal" style="max-width:360px;margin:64px auto">
        <h3>投资信息中台</h3>
        ${req.query.err ? '<p class="kv" style="color:var(--red)">密码不正确</p>' : ''}
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${esc(req.query.next || '/')}">
          <label>访问密码</label>
          <input type="password" name="password" autofocus autocomplete="current-password">
          <div style="margin-top:12px"><button class="btn btn-primary" type="submit" style="width:100%">进入</button></div>
        </form>
        <p class="kv" style="margin-top:10px">访客密码可浏览信息流与日报；管理密码可管理信息源与任务。</p>
      </div>`,
    }));
  });

  app.post('/login', (req, res) => {
    const role = matchPassword(req.body?.password);
    if (!role) return res.redirect(`/login?err=1&next=${encodeURIComponent(req.body?.next || '/')}`);
    const maxAge = config.auth.sessionDays * 86_400;
    res.setHeader('Set-Cookie',
      `session=${signSession(role)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
    const next = String(req.body?.next || '/');
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    res.redirect('/login');
  });
}
