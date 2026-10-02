'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tournament');
const { createStats } = require('../src/stats');

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Spielt einen kompletten Termin: der Teilnehmer mit kleinerer Nummer gewinnt immer
function playEvent(db, { id, date, mode = 'single', playerIds, seasonId = 's1' }, rng) {
  const per = mode === 'double' ? 2 : 1;
  const entries = [];
  for (let i = 0; i < playerIds.length; i += per) {
    entries.push({ id: `${id}-e${i / per}`, players: playerIds.slice(i, i + per), lot: i });
  }
  const strength = (eid) => Number(eid.split('-e')[1]);
  const event = {
    id,
    name: `Termin ${id}`,
    date,
    mode,
    seasonId,
    status: 'finished',
    bestOf: { quali: 3, cup: 3, final: 5 },
    entries,
    qualifying: { matches: T.generateQualifying(entries.map((e) => e.id), 5, rng) },
    cups: [],
  };
  const win = (m, bestOf) => {
    const aWins = strength(m.a) < strength(m.b);
    const need = Math.ceil(bestOf / 2);
    T.applyResult(m, aWins ? need : 0, aWins ? need - 1 : need, bestOf);
  };
  for (const m of event.qualifying.matches) if (!m.bye) win(m, 3);
  const ranked = T.qualifyingStandings(entries.map((e) => e.id), event.qualifying.matches, {}).map((r) => r.entryId);
  event.cups = T.splitIntoCups(ranked, 3).map((c) => T.createCup(c, c.entryIds, rng));
  for (const cup of event.cups) {
    while (T.cupPhase(cup) !== 'done') {
      for (const m of cup.matches.filter((x) => !x.winner)) win(m, m.stage === 'F' ? 5 : 3);
      T.advanceCup(cup, rng);
    }
  }
  db.events.push(event);
  return event;
}

function setup() {
  const rng = seeded(5);
  const users = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `Spieler ${i}` }));
  const db = { users, seasons: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2' }], events: [] };
  const ids = users.map((u) => u.id);
  playEvent(db, { id: 'a', date: '2026-01-10', playerIds: ids }, rng);
  playEvent(db, { id: 'b', date: '2026-02-10', playerIds: ids }, rng);
  playEvent(db, { id: 'c', date: '2026-03-10', mode: 'double', playerIds: ids, seasonId: 's2' }, rng);
  return db;
}

test('Spielerstatistik: Bilanz, Titel, Serien, Historie', () => {
  const db = setup();
  const stats = createStats(db);
  const best = stats.playerStats('u0');
  assert.strictEqual(best.summary.events, 3);
  // u0 ist immer der stärkste Teilnehmer und verliert nie
  assert.strictEqual(best.total.lost, 0);
  assert.strictEqual(best.total.winRate, 100);
  assert.strictEqual(best.summary.titles, 3);
  assert.strictEqual(best.summary.longestWinStreak, best.total.played);
  assert.strictEqual(best.history.length, 3);
  assert.strictEqual(best.history[0].eventId, 'c', 'neueste Termine zuerst');
  assert.strictEqual(best.history[0].partner, 'Spieler 1');
  assert.strictEqual(best.partners[0].userId, 'u1');
  assert.strictEqual(best.cupCounts.pro, 3);
  assert.ok(best.form.length <= 10 && best.form.every((f) => f.won));

  const worst = stats.playerStats('u11');
  assert.strictEqual(worst.total.won + worst.total.lost, worst.total.played);
  assert.ok(worst.total.lost > 0);
  assert.strictEqual(worst.cupCounts.beginner, 3);

  // Filter auf eine Season
  const s1 = stats.playerStats('u0', { seasonId: 's1' });
  assert.strictEqual(s1.summary.events, 2);
  assert.deepStrictEqual(s1.seasons.map((s) => s.id).sort(), ['s1', 's2']);

  // Direkter Vergleich ist symmetrisch
  const h = best.headToHead.find((x) => x.userId === 'u5');
  const back = stats.playerStats('u5').headToHead.find((x) => x.userId === 'u0');
  if (h) assert.deepStrictEqual([h.won, h.lost], [back.lost, back.won]);

  assert.strictEqual(stats.playerStats('nope'), null);
});

test('Bestenlisten und Archiv', () => {
  const db = setup();
  const o = createStats(db).overview();
  assert.strictEqual(o.totals.events, 3);
  assert.strictEqual(o.archive.length, 3);
  assert.strictEqual(o.archive[0].eventId, 'c');
  assert.strictEqual(o.archive[1].winners.length, 3);
  assert.strictEqual(o.leaderboards.titles[0].userId, 'u0');
  assert.ok(o.leaderboards.winRate.every((r) => r.played >= o.minMatches));
  const sumMatches = o.archive.reduce((s, a) => s + a.matches, 0);
  assert.strictEqual(o.totals.matches, sumMatches);
  assert.strictEqual(createStats(db).overview({ seasonId: 's2' }).totals.events, 1);
});

test('Turnier-Auswertung', () => {
  const db = setup();
  const ev = db.events[0];
  const s = createStats(db).eventStats(ev);
  assert.ok(s.totals.matches > 0);
  assert.strictEqual(s.totals.qualiMatches + s.totals.cupMatches, s.totals.matches);
  assert.strictEqual(s.championPaths.length, 3);
  assert.ok(s.championPaths.every((p) => p.matches.length > 0));
  assert.ok(s.upsets.every((u) => u.winnerSeed - u.loserSeed >= 2 && u.gap === u.winnerSeed - u.loserSeed));
  assert.ok(s.perfectQuali.includes('Spieler 0'));
});
