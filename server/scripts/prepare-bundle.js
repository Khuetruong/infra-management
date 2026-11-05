'use strict';
// Copies the agent sources into server/agent so they ship inside the Vercel function bundle.
// Runs automatically as the Vercel build step; harmless locally.
const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..', '..', 'agent');
const dst = path.join(__dirname, '..', 'agent');
if (fs.existsSync(src)) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  console.log('Bundled agent files from', src);
} else {
  console.log('No ../agent dir; assuming server/agent is already present');
}
