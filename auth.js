'use strict';

// Password hashing, signed session cookies and a login rate limiter.
// Uses only Node's built-in crypto, so no extra packages are needed.

const crypto = require('crypto');

const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Changes whenever the password changes, so old sessions stop working after a reset.
const passwordVersion = (passwordHash) =>
  crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 12);

const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

function createSession(userId, pv, secret, ttlMs, now = Date.now()) {
  const body = `${userId}.${now + ttlMs}.${pv}`;
  return `${body}.${sign(body, secret)}`;
}

// Reads the user id out of a token without trusting it (used only to look the user up).
function sessionUserId(token) {
  const parts = String(token || '').split('.');
  return parts.length === 4 ? parts[0] : null;
}

function verifySession(token, secret, pv, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return false;
  const [uid, exp, tokenPv, sig] = parts;
  const expected = sign(`${uid}.${exp}.${tokenPv}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > now && tokenPv === pv;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
    }
  });
  return out;
}

// Blocks a key (ip + username) after too many failed sign-ins.
function createLimiter({ max = 6, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  const fresh = (key, now) => (hits.get(key) || []).filter((t) => now - t < windowMs);
  return {
    blocked(key, now = Date.now()) { return fresh(key, now).length >= max; },
    hit(key, now = Date.now()) { hits.set(key, [...fresh(key, now), now]); },
    reset(key) { hits.delete(key); }
  };
}

module.exports = { hashPassword, verifyPassword, passwordVersion, createSession, sessionUserId, verifySession, parseCookies, createLimiter };
