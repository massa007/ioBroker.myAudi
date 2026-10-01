'use strict';

const http = require('http');
const path = require('path');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

const store = new Store(DATA_FILE);
const app = createApp(store, { publicDir: path.join(__dirname, 'public') });

http.createServer(app).listen(PORT, () => {
  console.log(`Darts-Turnierplaner läuft auf http://localhost:${PORT}`);
  console.log(`Daten: ${DATA_FILE}`);
});
