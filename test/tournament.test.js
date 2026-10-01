'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tournament');

function seeded(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ids = (n) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

// Spielt alle offenen Cup-Spiele, der besser gesetzte (oder per Zufall) gewinnt
function playCup(cup, rng, bestOf = 3) {
  let guard = 0;
  while (T.cupPhase(cup) !== 'done') {
    const open = cup.matches.filter((m) => !m.winner);
    assert.ok(open.length > 0, 'Es muss offene Spiele geben, solange der Cup nicht beendet ist');
    for (const m of open) {
      const aWins = rng() < 0.5;
      T.applyResult(m, aWins ? 2 : 1, aWins ? 1 : 2, bestOf);
    }
    T.advanceCup(cup, rng);
    assert.ok(++guard < 100);
  }
}

test('Vorrunde: jeder spielt 5 Mal (gerade Teilnehmerzahl), keine Wiederholungen wenn möglich', () => {
  const entries = ids(12);
  const matches = T.generateQualifying(entries, 5, seeded(1));
  for (const id of entries) {
    const n = matches.filter((m) => m.a === id || m.b === id).length;
    assert.strictEqual(n, 5);
  }
  const keys = matches.map((m) => [m.a, m.b].sort().join('|'));
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('Vorrunde: ungerade Teilnehmerzahl verteilt Freilose gleichmäßig', () => {
  const entries = ids(9);
  const matches = T.generateQualifying(entries, 5, seeded(2));
  const byes = matches.filter((m) => m.bye).map((m) => m.a);
  assert.strictEqual(byes.length, 5);
  assert.strictEqual(new Set(byes).size, 5);
  for (const id of entries) {
    assert.strictEqual(matches.filter((m) => m.a === id || m.b === id).length, 5);
  }
});

test('Vorrunde: Tabelle sortiert nach Siegen und Leg-Differenz', () => {
  const matches = [
    { a: 'x', b: 'y', legsA: 2, legsB: 0, winner: 'x' },
    { a: 'y', b: 'z', legsA: 2, legsB: 1, winner: 'y' },
    { a: 'z', b: 'x', legsA: 2, legsB: 1, winner: 'z' },
  ];
  const table = T.qualifyingStandings(['x', 'y', 'z'], matches, {});
  assert.deepStrictEqual(table.map((r) => r.entryId), ['x', 'z', 'y']);
  assert.strictEqual(table[0].legDiff, 1);
});

test('Cup-Aufteilung in Drittel, Rest an obere Cups', () => {
  const cups = T.splitIntoCups(ids(10), 3);
  assert.deepStrictEqual(cups.map((c) => c.key), ['pro', 'advanced', 'beginner']);
  assert.deepStrictEqual(cups.map((c) => c.entryIds.length), [4, 3, 3]);
  assert.deepStrictEqual(cups[0].entryIds, ['e1', 'e2', 'e3', 'e4']);
  assert.strictEqual(T.splitIntoCups(ids(3), 3).length, 1);
  assert.strictEqual(T.defaultCupCount(12), 3);
});

for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 11, 16, 23]) {
  test(`Cup mit ${n} Teilnehmern läuft komplett durch`, () => {
    for (let s = 1; s <= 25; s++) {
      const rng = seeded(s * 31 + n);
      const cup = T.createCup(T.CUP_DEFS[0], ids(n), rng);
      playCup(cup, rng);

      const { losses } = T.cupLosses(cup);
      // Vor dem Halbfinale scheidet niemand mit nur einer Niederlage aus
      const finalRound = cup.matches.filter((m) => m.stage === 'SF' || m.stage === 'F');
      const inFinals = new Set(finalRound.flatMap((m) => [m.a, m.b]).filter(Boolean));
      for (const id of cup.entryIds) {
        if (!inFinals.has(id)) assert.strictEqual(losses.get(id), 2, `${id} muss 2 Niederlagen haben`);
        else assert.ok(losses.get(id) <= 1);
      }
      assert.ok(inFinals.size === Math.min(4, n), `Finalrunde mit ${Math.min(4, n)} Teilnehmern`);

      const placements = T.cupPlacements(cup);
      assert.strictEqual(placements.length, n);
      assert.strictEqual(placements.filter((p) => p.place === 1).length, 1);
      assert.strictEqual(placements.filter((p) => p.category === 'final').length, 1);
    }
  });
}

test('Halbfinale: Winners-Bracket überkreuz gegen Losers-Bracket', () => {
  const rng = seeded(7);
  const cup = T.createCup(T.CUP_DEFS[0], ids(8), rng);
  while (T.cupPhase(cup) === 'bracket') {
    for (const m of cup.matches.filter((x) => !x.winner)) T.applyResult(m, 2, 0, 3);
    T.advanceCup(cup, rng);
  }
  const sf = cup.matches.filter((m) => m.stage === 'SF');
  assert.strictEqual(sf.length, 2);
  const { losses } = T.cupLosses(cup);
  for (const m of sf) {
    assert.deepStrictEqual([losses.get(m.a), losses.get(m.b)].sort(), [0, 1]);
  }
});

test('Letzte Runde zurücknehmen', () => {
  const rng = seeded(9);
  const cup = T.createCup(T.CUP_DEFS[0], ids(8), rng);
  for (const m of cup.matches) T.applyResult(m, 2, 1, 3);
  T.advanceCup(cup, rng);
  assert.strictEqual(T.currentRound(cup), 2);
  T.undoLastRound(cup);
  assert.strictEqual(T.currentRound(cup), 1);
  assert.throws(() => T.undoLastRound(cup));
});

test('Leg-Validierung', () => {
  assert.doesNotThrow(() => T.validateLegs(3, 2, 5));
  assert.throws(() => T.validateLegs(2, 2, 3));
  assert.throws(() => T.validateLegs(4, 1, 5));
});

test('Punkte je Termin', () => {
  const rng = seeded(3);
  const entries = ids(6).map((id) => ({ id, players: [id] }));
  const event = { entries, qualifying: { matches: T.generateQualifying(ids(6), 5, rng) } };
  for (const m of event.qualifying.matches) if (!m.bye) T.applyResult(m, 2, 0, 3);
  const table = T.qualifyingStandings(ids(6), event.qualifying.matches);
  event.cups = T.splitIntoCups(table.map((r) => r.entryId), 2).map((c) => T.createCup(c, c.entryIds, rng));
  event.cups.forEach((c) => playCup(c, rng));
  const pts = T.eventEntryPoints(event, T.DEFAULT_POINTS);
  const proWinner = pts.find((p) => p.cup === 'pro' && p.place === 1);
  assert.strictEqual(proWinner.points, 1 + proWinner.qualiWins + 20);
});
