'use strict';
const crypto = require('node:crypto');
const config = require('./config');

// ---- passwords (scrypt) ----
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

// ---- JWT (HS256) ----
const b64url = (s) => Buffer.from(s).toString('base64url');
function signJwt(payload, ttl = config.JWT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (h.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- opaque tokens (agent / enrollment): only the SHA-256 is stored ----
const randomToken = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(sha256(a), 'hex'), y = Buffer.from(sha256(b), 'hex');
  return crypto.timingSafeEqual(x, y);
};
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

// ---- secrets vault (AES-256-GCM) ----
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.MASTER_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

// ---- RBAC ----
const ROLES = ['viewer', 'operator', 'admin', 'owner'];
const roleRank = (r) => ROLES.indexOf(r);
const hasRole = (user, min) => !!user && roleRank(user.role) >= roleRank(min);

module.exports = {
  hashPassword, verifyPassword, signJwt, verifyJwt, randomToken, sha256, safeEqual, newId,
  encrypt, decrypt, ROLES, roleRank, hasRole,
};
