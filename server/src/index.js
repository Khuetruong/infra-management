'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const config = require('./config');
const { open } = require('./db');
const { createApp } = require('./app');

const db = open();
const app = createApp(db);

// Serve HTTPS directly when TLS_CERT/TLS_KEY are given; otherwise plain HTTP (put a TLS reverse proxy in front).
const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, app.handle)
  : http.createServer(app.handle);

server.listen(config.PORT, config.HOST, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`Control plane listening on ${proto}://${config.HOST}:${config.PORT} (db: ${db.kind})`);
});

const timer = setInterval(() => { app.tick().catch((e) => console.error('tick failed', e)); }, 15000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(timer); server.close(async () => { await db.close(); process.exit(0); }); });
}
