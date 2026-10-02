'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
// Standard: nur lokal erreichbar – öffentlich über einen Reverse Proxy mit HTTPS (siehe README)
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY).toLowerCase());
const COOKIE_SECURE = ['1', 'true', 'yes'].includes(String(process.env.COOKIE_SECURE).toLowerCase());

const store = new Store(DATA_FILE);

let setupToken = null;
if (!store.data.users.some((u) => u.role === 'admin')) {
  setupToken = process.env.SETUP_CODE || crypto.randomBytes(9).toString('base64url');
  console.log('──────────────────────────────────────────────────────────');
  console.log(' Noch kein Admin vorhanden. Setup-Code für die Registrierung:');
  console.log(`   ${setupToken}`);
  console.log('──────────────────────────────────────────────────────────');
}

const app = createApp(store, {
  publicDir: path.join(__dirname, 'public'),
  setupToken,
  trustProxy: TRUST_PROXY,
  secureCookies: COOKIE_SECURE,
});

const server = http.createServer(app);
// Schutz gegen langsame/hängende Verbindungen
server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => {
  console.log(`Darts-Turnierplaner läuft auf http://${HOST}:${PORT}`);
  console.log(`Daten: ${DATA_FILE}${TRUST_PROXY ? ' · Reverse Proxy vertraut' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
