'use strict';
// Usage: node src/cli.js create-admin <email> <password> [name] [role]
// Uses DATABASE_URL (Postgres) when set, otherwise the local SQLite file.
const { open, now } = require('./db');
const sec = require('./security');

(async () => {
  const [cmd, rawEmail, password, name, role = 'owner'] = process.argv.slice(2);
  if (cmd !== 'create-admin' || !rawEmail || !password) {
    console.error('Usage: node src/cli.js create-admin <email> <password> [name] [role]');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();
  if (password.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }
  if (!sec.ROLES.includes(role)) { console.error(`Role must be one of ${sec.ROLES.join(', ')}`); process.exit(1); }
  const db = open();
  const existing = await db.one('SELECT id FROM users WHERE email = ?', email);
  if (existing) {
    await db.run('UPDATE users SET password_hash = ?, role = ?, disabled = 0 WHERE id = ?', sec.hashPassword(password), role, existing.id);
    console.log(`Updated ${email} (${role})`);
  } else {
    await db.run('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)',
      sec.newId('usr'), email, name || email, sec.hashPassword(password), role, now());
    console.log(`Created ${email} (${role})`);
  }
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
