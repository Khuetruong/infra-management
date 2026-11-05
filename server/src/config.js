'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVERLESS = !!process.env.VERCEL;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (SERVERLESS ? '/tmp/infra-data' : path.join(__dirname, '..', 'data')));
if (!SERVERLESS) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// Load a 32-byte key from env (hex/base64) or a key file in DATA_DIR, generating it on first run.
function loadKey(envName, fileName) {
  const fromEnv = process.env[envName];
  if (fromEnv) {
    const buf = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new Error(`${envName} must be 32 bytes (64 hex chars or base64)`);
    return buf;
  }
  if (SERVERLESS) {
    // Each serverless instance has its own /tmp, so generated keys would differ between requests.
    throw new Error(`${envName} must be set as an environment variable on Vercel (64 hex chars)`);
  }
  const file = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

module.exports = {
  SERVERLESS,
  // Required to create the first (owner) account when set. Always required on Vercel, because the
  // public URL would otherwise let the first visitor claim the platform.
  SETUP_TOKEN: process.env.SETUP_TOKEN || '',
  PORT: Number(process.env.PORT || 8080),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  DB_FILE: process.env.DB_FILE || path.join(DATA_DIR, 'platform.db'),
  // Encrypts the secrets vault. Back it up separately from the database.
  MASTER_KEY: loadKey('MASTER_KEY', 'master.key'),
  JWT_SECRET: loadKey('JWT_SECRET', 'jwt.key'),
  JWT_TTL_SECONDS: Number(process.env.JWT_TTL_SECONDS || 8 * 3600),
  // Public URL of this API, e.g. https://infra.example.com (used to build agent install commands)
  PUBLIC_URL: process.env.PUBLIC_URL || '',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '', // empty = same-origin only (the web UI is served by this server)
  PLAN: process.env.PLAN || 'enterprise',
  AGENT_OFFLINE_AFTER_SECONDS: Number(process.env.AGENT_OFFLINE_AFTER_SECONDS || 90),
  TASK_TIMEOUT_SECONDS: Number(process.env.TASK_TIMEOUT_SECONDS || 900),
  ENROLL_TOKEN_TTL_SECONDS: Number(process.env.ENROLL_TOKEN_TTL_SECONDS || 24 * 3600),
};
