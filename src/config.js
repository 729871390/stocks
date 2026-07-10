import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config', 'default.json'), 'utf8'));
const localPath = path.join(root, 'config', 'local.json');
const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};

export const config = deepMerge(defaults, local);

// 部署环境变量覆盖（容器/PaaS 场景优先于配置文件）
if (process.env.PORT) config.web.port = Number(process.env.PORT);
if (process.env.PUBLIC_BASE_URL) config.web.baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
if (process.env.ADMIN_PASSWORD) config.auth.adminPassword = process.env.ADMIN_PASSWORD;
if (process.env.VIEWER_PASSWORD) config.auth.viewerPassword = process.env.VIEWER_PASSWORD;
if (process.env.SESSION_SECRET) config.auth.sessionSecret = process.env.SESSION_SECRET;

export const ROOT = root;
export const DATA_DIR = process.env.APP_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
