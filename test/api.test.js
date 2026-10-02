'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

function client(port, extraHeaders = {}) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...extraHeaders },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error);
      err.status = res.status;
      err.headers = res.headers;
      throw err;
    }
    return data;
  };
}

async function playAll(call, ev, stage) {
  for (let i = 0; i < 100; i++) {
    const open =
      stage === 'Q'
        ? ev.qualifying.matches.filter((m) => !m.winner)
        : ev.cups.flatMap((c) => c.matches.filter((m) => !m.winner));
    if (!open.length) return ev;
    const m = open[0];
    const need = Math.ceil(m.bestOf / 2);
    ev = await call('POST', `/api/events/${ev.id}/matches/${m.id}/result`, { legsA: need, legsB: i % need });
  }
  throw new Error('zu viele Spiele');
}

test('Kompletter Turnierablauf über die API', async (t) => {
  const store = new Store(null);
  const server = http.createServer(createApp(store, { setupToken: 'SETUP123' }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const port = server.address().port;

  const admin = client(port);
  const player = client(port);

  await assert.rejects(admin('POST', '/api/register', { username: 'chef', name: 'Chef', password: 'geheim123' }), { status: 403 });
  const reg = await admin('POST', '/api/register', { username: 'chef', name: 'Chef', password: 'geheim123', setupCode: 'SETUP123' });
  assert.strictEqual(reg.user.role, 'admin');
  const p = await player('POST', '/api/register', { username: 'paul', name: 'Paul', password: 'geheim234' });
  assert.strictEqual(p.user.role, 'player');
  assert.strictEqual(p.approved, false);

  // Nicht freigeschaltet: keine Anmeldung zu Terminen
  const ev0 = await admin('POST', '/api/events', { name: 'Test' });
  await assert.rejects(player('POST', `/api/events/${ev0.id}/register`), { status: 403 });
  await admin('DELETE', `/api/events/${ev0.id}`);
  await admin('PUT', `/api/users/${p.user.id}`, { approved: true });

  await assert.rejects(player('POST', '/api/seasons', { name: 'x' }), { status: 403 });
  const season = await admin('POST', '/api/seasons', { name: 'Season 1' });
  assert.ok(season.active);

  // Einzel-Turnier mit 13 Teilnehmern
  let ev = await admin('POST', '/api/events', { name: 'Dartsabend', date: '2026-10-10', mode: 'single' });
  assert.strictEqual(ev.seasonId, season.id);
  ev = await player('POST', `/api/events/${ev.id}/register`);
  ev = await admin('POST', `/api/events/${ev.id}/register`);
  for (let i = 0; i < 11; i++) {
    const g = await admin('POST', '/api/users/guest', { name: `Gast ${i + 1}` });
    ev = await admin('POST', `/api/events/${ev.id}/entries`, { playerIds: [g.id] });
  }
  assert.strictEqual(ev.entries.length, 13);
  await assert.rejects(player('POST', `/api/events/${ev.id}/register`), /bereits angemeldet/);

  ev = await admin('POST', `/api/events/${ev.id}/start-qualifying`);
  assert.strictEqual(ev.status, 'qualifying');
  assert.strictEqual(ev.qualifying.matches.filter((m) => m.bye).length, 5);

  // Spieler darf nur eigene Spiele eintragen
  const paulEntry = ev.entries.find((e) => e.players.some((pl) => pl.id === p.user.id)).id;
  const foreign = ev.qualifying.matches.find((m) => !m.bye && m.a !== paulEntry && m.b !== paulEntry);
  await assert.rejects(player('POST', `/api/events/${ev.id}/matches/${foreign.id}/result`, { legsA: 2, legsB: 0 }), { status: 403 });
  await assert.rejects(admin('POST', `/api/events/${ev.id}/matches/${foreign.id}/result`, { legsA: 1, legsB: 1 }), { status: 400 });

  await assert.rejects(admin('POST', `/api/events/${ev.id}/start-cups`, { numCups: 3 }), /offene|fehlen/);
  ev = await playAll(admin, ev, 'Q');
  ev = await admin('POST', `/api/events/${ev.id}/start-cups`, { numCups: 3 });
  assert.deepStrictEqual(ev.cups.map((c) => c.entryIds.length), [5, 4, 4]);

  ev = await playAll(admin, ev, 'C');
  assert.strictEqual(ev.status, 'finished');
  assert.ok(ev.cups.every((c) => c.placements.length === c.entryIds.length));

  const standings = await player('GET', `/api/seasons/${season.id}/standings`);
  assert.strictEqual(standings.rows.length, 13);
  assert.ok(standings.rows[0].points >= standings.rows[12].points);

  // Doppel mit Partnersuche und Auslosung
  let dbl = await admin('POST', '/api/events', { name: 'Doppelabend', mode: 'double' });
  const users = await admin('GET', '/api/users');
  const guests = users.filter((u) => u.guest);
  dbl = await admin('POST', `/api/events/${dbl.id}/entries`, { playerIds: [guests[0].id, guests[1].id] });
  dbl = await admin('POST', `/api/events/${dbl.id}/entries`, { playerIds: [guests[2].id] });
  dbl = await admin('POST', `/api/events/${dbl.id}/entries`, { playerIds: [guests[3].id] });
  dbl = await player('POST', `/api/events/${dbl.id}/register`);
  await assert.rejects(admin('POST', `/api/events/${dbl.id}/start-qualifying`), /unvollständig/);
  const solo = dbl.entries.find((e) => !e.complete);
  dbl = await admin('POST', `/api/events/${dbl.id}/entries/${solo.id}/join`);
  dbl = await admin('POST', `/api/events/${dbl.id}/pair-solos`);
  assert.strictEqual(dbl.entries.length, 3);
  assert.ok(dbl.entries.every((e) => e.complete));
  dbl = await admin('POST', `/api/events/${dbl.id}/start-qualifying`);
  dbl = await playAll(admin, dbl, 'Q');
  dbl = await admin('POST', `/api/events/${dbl.id}/start-cups`, { numCups: 1 });
  dbl = await playAll(admin, dbl, 'C');
  assert.strictEqual(dbl.status, 'finished');

  const st2 = await player('GET', `/api/seasons/${season.id}/standings`);
  const paul = st2.rows.find((r) => r.name === 'Paul');
  assert.ok(paul.double > 0 && paul.single > 0);
  assert.strictEqual(paul.events, 2);

  // Statistiken sind öffentlich lesbar, ohne Login-Namen preiszugeben
  const anon = client(port);
  const ps = await anon('GET', `/api/players/${p.user.id}/stats`);
  assert.strictEqual(ps.summary.events, 2);
  assert.strictEqual(ps.total.played, ps.total.won + ps.total.lost);
  assert.ok(!JSON.stringify(ps).includes('paul'), 'Benutzername darf nicht enthalten sein');
  const ov = await anon('GET', `/api/stats/overview?season=${season.id}`);
  assert.strictEqual(ov.totals.events, 2);
  const es = await anon('GET', `/api/events/${ev.id}/stats`);
  assert.strictEqual(es.championPaths.length, 3);
  await assert.rejects(anon('GET', '/api/players/gibtsnicht/stats'), { status: 404 });
});

test('Sicherheit: Header, Login-Drosselung, CSRF, Sessions', async (t) => {
  const store = new Store(null);
  const server = http.createServer(createApp(store, { setupToken: 'X', publicDir: require('path').join(__dirname, '..', 'public') }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const a = client(port);
  await a('POST', '/api/register', { username: 'admin', name: 'A', password: 'langespasswort', setupCode: 'X' });

  // Security-Header
  const res = await fetch(`${base}/api/me`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');

  // Session-Token wird nur gehasht gespeichert
  assert.ok(store.data.sessions.every((s) => s.tokenHash && !s.token));

  // Benutzernamen sind für andere Spieler unsichtbar
  await a('PUT', '/api/settings', { requireApproval: false });
  const b = client(port);
  await b('POST', '/api/register', { username: 'bob', name: 'Bob', password: 'langespasswort' });
  const seenByBob = await b('GET', '/api/users');
  assert.strictEqual(seenByBob.find((u) => u.name === 'A').username, null);

  // Fremde Origin wird abgelehnt
  const evil = client(port, { Origin: 'https://evil.example' });
  await assert.rejects(evil('POST', '/api/login', { username: 'admin', password: 'x' }), { status: 403 });

  // Kein Formular-POST ohne JSON
  const form = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
  assert.strictEqual(form.status, 415);

  // Login-Drosselung nach 5 Fehlversuchen
  const c = client(port);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(c('POST', '/api/login', { username: 'admin', password: 'falsch' }), { status: 401 });
  }
  await assert.rejects(c('POST', '/api/login', { username: 'admin', password: 'langespasswort' }), { status: 429 });

  // Registrierung kann geschlossen werden
  await a('PUT', '/api/settings', { registrationOpen: false });
  await assert.rejects(client(port)('POST', '/api/register', { username: 'zed', name: 'Z', password: 'langespasswort' }), { status: 403 });

  // Path Traversal bei statischen Dateien
  const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.strictEqual(trav.status, 404);
  const idx = await fetch(`${base}/events/abc`);
  assert.match(await idx.text(), /<!doctype html>/i);
});
