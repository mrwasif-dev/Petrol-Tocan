'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('./auth');

test('password hash verifies only the right password', async () => {
  const h = await a.hashPassword('s3cret!');
  assert.equal(await a.verifyPassword('s3cret!', h), true);
  assert.equal(await a.verifyPassword('wrong', h), false);
  assert.equal(await a.verifyPassword('s3cret!', 'garbage'), false);
});

test('session token: valid, tampered, expired, password changed', () => {
  const pv = a.passwordVersion('hash-1');
  const t = a.createSession('u1', pv, 'secret', 1000, 5000);
  assert.equal(a.sessionUserId(t), 'u1');
  assert.equal(a.verifySession(t, 'secret', pv, 5500), true);
  assert.equal(a.verifySession(t, 'other-secret', pv, 5500), false);
  assert.equal(a.verifySession(t.replace('u1', 'u2'), 'secret', pv, 5500), false);
  assert.equal(a.verifySession(t, 'secret', pv, 7000), false);
  assert.equal(a.verifySession(t, 'secret', a.passwordVersion('hash-2'), 5500), false);
  assert.equal(a.verifySession('nonsense', 'secret', pv), false);
});

test('cookie parsing', () => {
  assert.deepEqual(a.parseCookies('a=1; ftt_session=x.y%2Bz; b'), { a: '1', ftt_session: 'x.y+z' });
});

test('limiter blocks after max failures and resets', () => {
  const l = a.createLimiter({ max: 3, windowMs: 1000 });
  [0, 1, 2].forEach((t) => l.hit('k', t));
  assert.equal(l.blocked('k', 3), true);
  assert.equal(l.blocked('k', 1500), false);
  l.hit('k', 1600); l.reset('k');
  assert.equal(l.blocked('k', 1601), false);
});
