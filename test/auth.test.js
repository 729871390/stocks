import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { signSession, verifySession, matchPassword, authEnabled } from '../src/web/auth.js';

function withAuth(fn) {
  const saved = { ...config.auth };
  config.auth.adminPassword = 'admin-pw';
  config.auth.viewerPassword = 'viewer-pw';
  config.auth.sessionSecret = '';
  try { fn(); } finally { Object.assign(config.auth, saved); }
}

test('会话签名与校验', () => {
  withAuth(() => {
    assert.ok(authEnabled());
    const token = signSession('viewer');
    assert.equal(verifySession(token), 'viewer');
    // 篡改角色 -> 拒绝
    const forged = Buffer.from(`admin.${Date.now() + 86400000}`).toString('base64url') + '.' + token.split('.').pop();
    assert.equal(verifySession(forged), null);
    assert.equal(verifySession('garbage'), null);
    assert.equal(verifySession(null), null);
    // 过期 -> 拒绝
    const expired = signSession('admin', -1);
    assert.equal(verifySession(expired), null);
  });
});

test('密码匹配区分角色', () => {
  withAuth(() => {
    assert.equal(matchPassword('admin-pw'), 'admin');
    assert.equal(matchPassword('viewer-pw'), 'viewer');
    assert.equal(matchPassword('wrong'), null);
    assert.equal(matchPassword(''), null);
  });
});

test('改密码即全员下线（派生密钥）', () => {
  withAuth(() => {
    const token = signSession('admin');
    config.auth.adminPassword = 'rotated';
    assert.equal(verifySession(token), null);
  });
});
