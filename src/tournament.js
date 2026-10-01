'use strict';

/*
 * Reine Turnier-Logik ohne I/O.
 *
 * Ablauf eines Termins:
 *   1. Vorrunde: jeder Teilnehmer spielt N (Standard 5) Spiele gegen zufällige Gegner.
 *   2. Aufteilung nach Vorrunden-Tabelle in bis zu 3 Cups (Pro / Advanced / Beginners).
 *   3. Innerhalb eines Cups: Doppel-K.o. (Winners- und Losers-Bracket), bis aus beiden
 *      Brackets je 2 Teilnehmer übrig sind. Ab dem Halbfinale gilt einfaches K.o.
 */

const CUP_DEFS = [
  { key: 'pro', name: 'Pro Cup' },
  { key: 'advanced', name: 'Advanced Cup' },
  { key: 'beginner', name: 'Beginners Cup' },
];

const DEFAULT_POINTS = {
  participation: 1,
  qualiWin: 1,
  cups: {
    pro: { winner: 20, final: 15, semi: 10, other: 5 },
    advanced: { winner: 12, final: 9, semi: 6, other: 3 },
    beginner: { winner: 8, final: 6, semi: 4, other: 2 },
  },
};

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function meetings(matches) {
  const met = new Map();
  for (const m of matches) {
    if (m.bye || !m.b) continue;
    const k = pairKey(m.a, m.b);
    met.set(k, (met.get(k) || 0) + 1);
  }
  return met;
}

/**
 * Paart eine gerade Anzahl von IDs zufällig und minimiert dabei Wiederholungs-Begegnungen.
 */
function bestPairing(pool, met, rng = Math.random, attempts = 300) {
  let best = null;
  let bestCost = Infinity;
  for (let t = 0; t < attempts && bestCost > 0; t++) {
    const rest = shuffle(pool, rng);
    const pairs = [];
    let cost = 0;
    while (rest.length) {
      const a = rest.shift();
      let min = Infinity;
      let cands = [];
      for (let i = 0; i < rest.length; i++) {
        const c = met.get(pairKey(a, rest[i])) || 0;
        if (c < min) {
          min = c;
          cands = [i];
        } else if (c === min) {
          cands.push(i);
        }
      }
      const idx = cands[Math.floor(rng() * cands.length)];
      const [b] = rest.splice(idx, 1);
      cost += min;
      pairs.push([a, b]);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = pairs;
    }
  }
  return best || [];
}

function newMatch(id, fields) {
  return { id, legsA: null, legsB: null, winner: null, ...fields };
}

function byeMatch(id, entryId, fields) {
  return { ...newMatch(id, fields), a: entryId, b: null, winner: entryId, bye: true };
}

// ---------------------------------------------------------------------------
// Vorrunde
// ---------------------------------------------------------------------------

/**
 * Erzeugt alle Vorrunden-Spiele. Bei ungerader Teilnehmerzahl erhält pro Runde ein
 * Teilnehmer ein Freilos (zählt als Sieg); Freilose werden möglichst gleich verteilt.
 */
function generateQualifying(entryIds, rounds = 5, rng = Math.random) {
  if (entryIds.length < 2) throw new Error('Mindestens 2 Teilnehmer erforderlich');
  const met = new Map();
  const byes = new Map(entryIds.map((id) => [id, 0]));
  const matches = [];
  let n = 0;
  for (let r = 1; r <= rounds; r++) {
    let pool = shuffle(entryIds, rng);
    let bye = null;
    if (pool.length % 2 === 1) {
      const minByes = Math.min(...pool.map((id) => byes.get(id)));
      const cands = pool.filter((id) => byes.get(id) === minByes);
      bye = cands[Math.floor(rng() * cands.length)];
      pool = pool.filter((id) => id !== bye);
      byes.set(bye, byes.get(bye) + 1);
    }
    for (const [a, b] of bestPairing(pool, met, rng)) {
      const k = pairKey(a, b);
      met.set(k, (met.get(k) || 0) + 1);
      matches.push(newMatch(`q${++n}`, { stage: 'Q', round: r, a, b }));
    }
    if (bye) matches.push(byeMatch(`q${++n}`, bye, { stage: 'Q', round: r }));
  }
  return matches;
}

/**
 * Tabelle der Vorrunde. Sortierung: Siege, Leg-Differenz, gewonnene Legs, Los.
 */
function qualifyingStandings(entryIds, matches, lots = {}) {
  const rows = new Map(
    entryIds.map((id) => [
      id,
      { entryId: id, played: 0, wins: 0, losses: 0, byes: 0, legsFor: 0, legsAgainst: 0 },
    ])
  );
  for (const m of matches) {
    if (m.bye) {
      const r = rows.get(m.a);
      if (r) {
        r.wins++;
        r.byes++;
      }
      continue;
    }
    if (!m.winner) continue;
    const ra = rows.get(m.a);
    const rb = rows.get(m.b);
    if (!ra || !rb) continue;
    ra.played++;
    rb.played++;
    ra.legsFor += m.legsA;
    ra.legsAgainst += m.legsB;
    rb.legsFor += m.legsB;
    rb.legsAgainst += m.legsA;
    if (m.winner === m.a) {
      ra.wins++;
      rb.losses++;
    } else {
      rb.wins++;
      ra.losses++;
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, legDiff: r.legsFor - r.legsAgainst }));
  list.sort(
    (x, y) =>
      y.wins - x.wins ||
      y.legDiff - x.legDiff ||
      y.legsFor - x.legsFor ||
      (lots[x.entryId] ?? 0) - (lots[y.entryId] ?? 0)
  );
  list.forEach((r, i) => (r.rank = i + 1));
  return list;
}

// ---------------------------------------------------------------------------
// Cups
// ---------------------------------------------------------------------------

function defaultCupCount(n) {
  return Math.max(1, Math.min(3, Math.floor(n / 4)));
}

function maxCupCount(n) {
  return Math.max(1, Math.min(3, Math.floor(n / 2)));
}

/**
 * Teilt die nach Vorrunde sortierten Teilnehmer in Cups auf
 * (oberes Drittel -> Pro, mittleres -> Advanced, unteres -> Beginners).
 * Überzählige Plätze gehen an die oberen Cups.
 */
function splitIntoCups(rankedIds, numCups) {
  const n = rankedIds.length;
  const k = Math.max(1, Math.min(numCups || defaultCupCount(n), maxCupCount(n)));
  const base = Math.floor(n / k);
  const rem = n % k;
  const cups = [];
  let idx = 0;
  for (let i = 0; i < k; i++) {
    const size = base + (i < rem ? 1 : 0);
    cups.push({ ...CUP_DEFS[i], entryIds: rankedIds.slice(idx, idx + size) });
    idx += size;
  }
  return cups;
}

function cupLosses(cup) {
  const losses = new Map(cup.entryIds.map((id) => [id, 0]));
  const lastLossRound = new Map();
  for (const m of cup.matches) {
    if (m.bye || !m.winner || (m.stage !== 'W' && m.stage !== 'L')) continue;
    const loser = m.winner === m.a ? m.b : m.a;
    losses.set(loser, losses.get(loser) + 1);
    lastLossRound.set(loser, m.round);
  }
  return { losses, lastLossRound };
}

function cupPhase(cup) {
  const final = cup.matches.find((m) => m.stage === 'F');
  if (final) return final.winner ? 'done' : 'final';
  if (cup.matches.some((m) => m.stage === 'SF')) return 'semi';
  return 'bracket';
}

function currentRound(cup) {
  return cup.matches.reduce((max, m) => Math.max(max, m.round), 0);
}

function roundComplete(cup) {
  const r = currentRound(cup);
  return cup.matches.filter((m) => m.round === r).every((m) => m.winner);
}

function seedOf(cup, id) {
  return cup.entryIds.indexOf(id);
}

function bySeed(cup, ids) {
  return [...ids].sort((a, b) => seedOf(cup, a) - seedOf(cup, b));
}

function pairBracketRound(cup, ids, stage, round, nextId, rng) {
  let pool = bySeed(cup, ids);
  const out = [];
  if (pool.length % 2 === 1) {
    const hadBye = new Set(cup.matches.filter((m) => m.bye).map((m) => m.a));
    const bye = pool.find((id) => !hadBye.has(id)) ?? pool[0];
    pool = pool.filter((id) => id !== bye);
    out.push(byeMatch(nextId(), bye, { stage, round }));
  }
  const firstWinnersRound = stage === 'W' && !cup.matches.some((m) => m.stage === 'W');
  let pairs;
  if (firstWinnersRound) {
    // Gesetzt: Bester gegen Schwächsten
    pairs = [];
    for (let i = 0; i < pool.length / 2; i++) pairs.push([pool[i], pool[pool.length - 1 - i]]);
  } else {
    pairs = bestPairing(pool, meetings(cup.matches), rng).map((p) => bySeed(cup, p));
  }
  const matches = pairs.map(([a, b]) => newMatch(nextId(), { stage, round, a, b }));
  return [...matches, ...out];
}

function generateNextRound(cup, rng) {
  const phase = cupPhase(cup);
  if (phase === 'done') return false;
  const round = currentRound(cup) + 1;
  let counter = cup.matches.length;
  const nextId = () => `${cup.key}-${++counter}`;
  const add = [];

  if (phase === 'bracket') {
    const { losses } = cupLosses(cup);
    const W = cup.entryIds.filter((id) => losses.get(id) === 0);
    const L = cup.entryIds.filter((id) => losses.get(id) === 1);
    if (W.length > 2 || L.length > 2) {
      if (W.length > 2) add.push(...pairBracketRound(cup, W, 'W', round, nextId, rng));
      if (L.length > 2) add.push(...pairBracketRound(cup, L, 'L', round, nextId, rng));
    } else {
      const w = bySeed(cup, W);
      const l = bySeed(cup, L);
      const total = w.length + l.length;
      if (total === 4) {
        // Überkreuz: Winners-Bracket gegen Losers-Bracket, Wiederholungen möglichst vermeiden
        const met = meetings(cup.matches);
        const cost = (pairs) => pairs.reduce((s, [a, b]) => s + (met.get(pairKey(a, b)) || 0), 0);
        const optA = [[w[0], l[1]], [w[1], l[0]]];
        const optB = [[w[0], l[0]], [w[1], l[1]]];
        const pairs = cost(optB) < cost(optA) ? optB : optA;
        for (const [a, b] of pairs) add.push(newMatch(nextId(), { stage: 'SF', round, a, b }));
      } else if (total === 3) {
        add.push(newMatch(nextId(), { stage: 'SF', round, a: w[1], b: l[0] }));
        add.push(byeMatch(nextId(), w[0], { stage: 'SF', round }));
      } else if (total === 2) {
        const [a, b] = [...w, ...l];
        add.push(newMatch(nextId(), { stage: 'F', round, a, b }));
      } else {
        return false;
      }
    }
  } else if (phase === 'semi') {
    const sf = cup.matches.filter((m) => m.stage === 'SF');
    const [a, b] = bySeed(cup, sf.map((m) => m.winner));
    add.push(newMatch(nextId(), { stage: 'F', round, a, b }));
  } else {
    return false;
  }

  cup.matches.push(...add);
  return true;
}

/**
 * Erzeugt neue Runden, solange die aktuelle Runde komplett ist
 * (Runden, die nur aus Freilosen bestehen, werden automatisch übersprungen).
 */
function advanceCup(cup, rng = Math.random) {
  let guard = 0;
  while (roundComplete(cup) && generateNextRound(cup, rng)) {
    if (++guard > 200) throw new Error('Cup-Generierung hängt');
  }
  return cup;
}

function createCup(def, entryIds, rng = Math.random) {
  const cup = { key: def.key, name: def.name, entryIds: [...entryIds], matches: [] };
  return advanceCup(cup, rng);
}

/**
 * Platzierungen eines abgeschlossenen Cups.
 * category: winner | final | semi | other
 */
function cupPlacements(cup) {
  if (cupPhase(cup) !== 'done') return null;
  const final = cup.matches.find((m) => m.stage === 'F');
  const groups = [];
  groups.push({ ids: [final.winner], category: 'winner' });
  groups.push({ ids: [final.winner === final.a ? final.b : final.a], category: 'final' });
  const semiLosers = cup.matches
    .filter((m) => m.stage === 'SF' && !m.bye)
    .map((m) => (m.winner === m.a ? m.b : m.a));
  if (semiLosers.length) groups.push({ ids: semiLosers, category: 'semi' });

  const placed = new Set(groups.flatMap((g) => g.ids));
  const { lastLossRound } = cupLosses(cup);
  const byRound = new Map();
  for (const id of cup.entryIds) {
    if (placed.has(id)) continue;
    const r = lastLossRound.get(id) || 0;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r).push(id);
  }
  [...byRound.keys()]
    .sort((a, b) => b - a)
    .forEach((r) => groups.push({ ids: byRound.get(r), category: 'other' }));

  const result = [];
  let place = 1;
  for (const g of groups) {
    for (const id of g.ids) result.push({ entryId: id, place, category: g.category });
    place += g.ids.length;
  }
  return result;
}

/**
 * Letzte Runde eines Cups zurücknehmen (nur wenn dort noch kein Ergebnis eingetragen ist).
 */
function undoLastRound(cup) {
  const r = currentRound(cup);
  if (r <= 1) throw new Error('Die erste Runde kann nicht zurückgenommen werden');
  const last = cup.matches.filter((m) => m.round === r);
  if (last.some((m) => !m.bye && m.winner)) {
    throw new Error('In der letzten Runde wurden bereits Ergebnisse eingetragen');
  }
  cup.matches = cup.matches.filter((m) => m.round !== r);
  // Reine Freilos-Runden davor ebenfalls entfernen
  while (currentRound(cup) > 1) {
    const prev = cup.matches.filter((m) => m.round === currentRound(cup));
    if (!prev.every((m) => m.bye)) break;
    cup.matches = cup.matches.filter((m) => m.round !== currentRound(cup));
  }
  return cup;
}

// ---------------------------------------------------------------------------
// Ergebnisse & Punkte
// ---------------------------------------------------------------------------

function legsToWin(bestOf) {
  return Math.ceil(bestOf / 2);
}

function validateLegs(legsA, legsB, bestOf) {
  if (![legsA, legsB].every((x) => Number.isInteger(x) && x >= 0)) {
    throw new Error('Legs müssen ganze Zahlen ≥ 0 sein');
  }
  const need = legsToWin(bestOf);
  if (Math.max(legsA, legsB) !== need || Math.min(legsA, legsB) >= need) {
    throw new Error(`Best of ${bestOf}: der Sieger braucht genau ${need} Legs`);
  }
}

function applyResult(match, legsA, legsB, bestOf) {
  if (match.bye) throw new Error('Freilos hat kein Ergebnis');
  validateLegs(legsA, legsB, bestOf);
  match.legsA = legsA;
  match.legsB = legsB;
  match.winner = legsA > legsB ? match.a : match.b;
  return match;
}

function mergePoints(scheme) {
  const s = scheme || {};
  const cups = {};
  for (const def of CUP_DEFS) {
    cups[def.key] = { ...DEFAULT_POINTS.cups[def.key], ...((s.cups || {})[def.key] || {}) };
  }
  return {
    participation: s.participation ?? DEFAULT_POINTS.participation,
    qualiWin: s.qualiWin ?? DEFAULT_POINTS.qualiWin,
    cups,
  };
}

/**
 * Punkte je Teilnehmer (Entry) eines Termins.
 * Freilose zählen in der Vorrunden-Tabelle als Sieg, bringen aber keine Siegpunkte.
 */
function eventEntryPoints(event, scheme) {
  const pts = mergePoints(scheme);
  const res = new Map();
  for (const e of event.entries) {
    res.set(e.id, { entryId: e.id, qualiWins: 0, cup: null, place: null, category: null, points: pts.participation });
  }
  for (const m of event.qualifying?.matches || []) {
    if (m.bye || !m.winner) continue;
    const r = res.get(m.winner);
    if (r) {
      r.qualiWins++;
      r.points += pts.qualiWin;
    }
  }
  for (const cup of event.cups || []) {
    const placements = cupPlacements(cup);
    for (const id of cup.entryIds) {
      const r = res.get(id);
      if (r) r.cup = cup.key;
    }
    if (!placements) continue;
    for (const p of placements) {
      const r = res.get(p.entryId);
      if (!r) continue;
      r.place = p.place;
      r.category = p.category;
      r.points += pts.cups[cup.key]?.[p.category] ?? 0;
    }
  }
  return [...res.values()];
}

module.exports = {
  CUP_DEFS,
  DEFAULT_POINTS,
  shuffle,
  bestPairing,
  generateQualifying,
  qualifyingStandings,
  defaultCupCount,
  maxCupCount,
  splitIntoCups,
  createCup,
  advanceCup,
  cupPhase,
  currentRound,
  cupLosses,
  cupPlacements,
  undoLastRound,
  legsToWin,
  validateLegs,
  applyResult,
  mergePoints,
  eventEntryPoints,
};
