'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

function client(port) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error);
      err.status = res.status;
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
  const server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const port = server.address().port;

  const admin = client(port);
  const player = client(port);

  const reg = await admin('POST', '/api/register', { username: 'chef', name: 'Chef', password: 'geheim1' });
  assert.strictEqual(reg.user.role, 'admin');
  const p = await player('POST', '/api/register', { username: 'paul', name: 'Paul', password: 'geheim2' });
  assert.strictEqual(p.user.role, 'player');

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
  const foreign = ev.qualifying.matches.find((m) => !m.bye && m.a !== ev.myEntryId && m.b !== ev.myEntryId);
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
});
