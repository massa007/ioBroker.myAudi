'use strict';

/*
 * Statistiken: Spielerprofile, Bestenlisten, Turnier-Auswertungen.
 * Reine Funktionen über den Datenbestand – kein I/O.
 */

const T = require('./tournament');

const STAGE_ORDER = { Q: 0, W: 1, L: 1, SF: 2, F: 3 };

function byDate(a, b) {
  return (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || '');
}

function bestOfFor(event, m) {
  if (m.stage === 'Q') return event.bestOf.quali;
  if (m.stage === 'F') return event.bestOf.final;
  return event.bestOf.cup;
}

/** Alle gespielten Partien (ohne Freilose) eines Termins in Spielreihenfolge */
function playedMatches(event) {
  const list = [];
  for (const m of event.qualifying?.matches || []) {
    if (!m.bye && m.winner) list.push({ ...m, cupKey: null });
  }
  for (const cup of event.cups || []) {
    for (const m of cup.matches) if (!m.bye && m.winner) list.push({ ...m, cupKey: cup.key });
  }
  list.sort((x, y) => STAGE_ORDER[x.stage] - STAGE_ORDER[y.stage] || x.round - y.round);
  return list.map((m) => {
    const need = T.legsToWin(bestOfFor(event, m));
    const loserLegs = Math.min(m.legsA, m.legsB);
    return { ...m, whitewash: need > 1 && loserLegs === 0, decider: need > 1 && loserLegs === need - 1 };
  });
}

/** Sicht eines Teilnehmers auf eine Partie */
function perspective(m, entryId) {
  const isA = m.a === entryId;
  return {
    won: m.winner === entryId,
    legsFor: isA ? m.legsA : m.legsB,
    legsAgainst: isA ? m.legsB : m.legsA,
    opponent: isA ? m.b : m.a,
  };
}

function emptyRecord() {
  return { played: 0, won: 0, lost: 0, legsFor: 0, legsAgainst: 0 };
}

function addToRecord(r, p) {
  r.played++;
  if (p.won) r.won++;
  else r.lost++;
  r.legsFor += p.legsFor;
  r.legsAgainst += p.legsAgainst;
}

function finishRecord(r) {
  return { ...r, legDiff: r.legsFor - r.legsAgainst, winRate: r.played ? Math.round((r.won / r.played) * 1000) / 10 : null };
}

function streaks(results) {
  let best = 0;
  let cur = 0;
  for (const won of results) {
    cur = won ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  // aktuelle Serie (Siege oder Niederlagen) vom Ende her
  let current = 0;
  const last = results[results.length - 1];
  for (let i = results.length - 1; i >= 0 && results[i] === last; i--) current++;
  return { longestWinStreak: best, current: results.length ? { type: last ? 'W' : 'L', count: current } : null };
}

function createStats(db) {
  const userById = (id) => db.users.find((u) => u.id === id);
  const userName = (id) => userById(id)?.name || '?';
  const entryName = (entry) => entry.teamName || entry.players.map(userName).join(' & ');
  const schemeFor = (event) => T.mergePoints(db.seasons.find((s) => s.id === event.seasonId)?.points);

  function eventsFor({ seasonId = null, finishedOnly = false } = {}) {
    return db.events
      .filter((e) => e.status !== 'registration')
      .filter((e) => !finishedOnly || e.status === 'finished')
      .filter((e) => !seasonId || e.seasonId === seasonId)
      .sort(byDate);
  }

  // ---------------------------------------------------------------- Spieler

  function playerStats(userId, { seasonId = null } = {}) {
    const user = userById(userId);
    if (!user) return null;

    const allEvents = eventsFor().filter((e) => e.entries.some((x) => x.players.includes(userId)));
    const seasons = [...new Set(allEvents.map((e) => e.seasonId).filter(Boolean))]
      .map((id) => db.seasons.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => ({ id: s.id, name: s.name }));
    const events = allEvents.filter((e) => !seasonId || e.seasonId === seasonId);

    const total = emptyRecord();
    const byStage = { quali: emptyRecord(), cups: emptyRecord(), finals: emptyRecord() };
    const byMode = { single: emptyRecord(), double: emptyRecord() };
    const cupCounts = { pro: 0, advanced: 0, beginner: 0 };
    const bestPlace = { pro: null, advanced: null, beginner: null };
    const h2h = new Map();
    const partners = new Map();
    const results = [];
    const form = [];
    const history = [];
    let whitewashes = 0;
    const deciders = { won: 0, lost: 0 };
    let titles = 0;
    let finals = 0;
    let semis = 0;
    let points = 0;

    for (const ev of events) {
      const entry = ev.entries.find((x) => x.players.includes(userId));
      const partnerIds = entry.players.filter((p) => p !== userId);
      const pts = T.eventEntryPoints(ev, schemeFor(ev)).find((p) => p.entryId === entry.id);
      const lots = Object.fromEntries(ev.entries.map((e) => [e.id, e.lot ?? 0]));
      const table = ev.qualifying ? T.qualifyingStandings(ev.entries.map((e) => e.id), ev.qualifying.matches, lots) : [];
      const qRow = table.find((r) => r.entryId === entry.id);
      const evRecord = emptyRecord();

      for (const m of playedMatches(ev)) {
        if (m.a !== entry.id && m.b !== entry.id) continue;
        const p = perspective(m, entry.id);
        addToRecord(total, p);
        addToRecord(evRecord, p);
        addToRecord(byMode[ev.mode], p);
        addToRecord(m.stage === 'Q' ? byStage.quali : m.stage === 'SF' || m.stage === 'F' ? byStage.finals : byStage.cups, p);
        results.push(p.won);
        if (p.won && m.whitewash) whitewashes++;
        if (m.decider) deciders[p.won ? 'won' : 'lost']++;

        const opp = ev.entries.find((x) => x.id === p.opponent);
        form.push({
          won: p.won,
          score: `${p.legsFor}:${p.legsAgainst}`,
          opponent: opp ? entryName(opp) : '?',
          eventId: ev.id,
          eventName: ev.name,
          stage: m.stage,
        });
        for (const oid of opp?.players || []) {
          if (!h2h.has(oid)) h2h.set(oid, emptyRecord());
          addToRecord(h2h.get(oid), p);
        }
        for (const pid of partnerIds) {
          if (!partners.has(pid)) partners.set(pid, { ...emptyRecord(), events: new Set() });
          addToRecord(partners.get(pid), p);
        }
      }
      for (const pid of partnerIds) {
        if (!partners.has(pid)) partners.set(pid, { ...emptyRecord(), events: new Set() });
        partners.get(pid).events.add(ev.id);
      }

      const finished = ev.status === 'finished';
      if (pts?.cup) cupCounts[pts.cup]++;
      if (finished && pts) {
        points += pts.points;
        if (pts.category === 'winner') titles++;
        if (pts.category === 'winner' || pts.category === 'final') finals++;
        if (pts.category === 'semi') semis++;
        if (pts.cup && pts.place && (bestPlace[pts.cup] === null || pts.place < bestPlace[pts.cup])) bestPlace[pts.cup] = pts.place;
      }

      history.push({
        eventId: ev.id,
        name: ev.name,
        date: ev.date,
        mode: ev.mode,
        status: ev.status,
        seasonId: ev.seasonId,
        partner: partnerIds.map(userName).join(' & ') || null,
        quali: qRow ? { rank: qRow.rank, of: table.length, wins: qRow.wins, losses: qRow.losses } : null,
        cup: pts?.cup || null,
        place: finished ? pts?.place ?? null : null,
        category: finished ? pts?.category ?? null : null,
        points: finished ? pts?.points ?? 0 : null,
        record: finishRecord(evRecord),
      });
    }

    const h2hList = [...h2h.entries()]
      .map(([id, r]) => ({ userId: id, name: userName(id), ...finishRecord(r) }))
      .sort((a, b) => b.played - a.played || b.won - a.won || a.name.localeCompare(b.name));
    const partnerList = [...partners.entries()]
      .map(([id, { events: evs, ...r }]) => ({ userId: id, name: userName(id), eventCount: evs.size, ...finishRecord(r) }))
      .sort((a, b) => b.eventCount - a.eventCount || b.won - a.won);

    return {
      player: { id: user.id, name: user.name, guest: !!user.guest },
      seasons,
      seasonId,
      summary: {
        events: events.length,
        finishedEvents: events.filter((e) => e.status === 'finished').length,
        titles,
        finals,
        semis,
        points,
        whitewashes,
        deciders,
        ...streaks(results),
      },
      total: finishRecord(total),
      byStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, finishRecord(v)])),
      byMode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, finishRecord(v)])),
      cupCounts,
      bestPlace,
      form: form.slice(-10),
      headToHead: h2hList.slice(0, 15),
      nemesis: h2hList.filter((x) => x.played >= 2 && x.lost > x.won).sort((a, b) => b.lost - b.won - (a.lost - a.won))[0] || null,
      favourite: h2hList.filter((x) => x.played >= 2 && x.won > x.lost).sort((a, b) => b.won - b.lost - (a.won - a.lost))[0] || null,
      partners: partnerList,
      history: history.reverse(),
    };
  }

  // ---------------------------------------------------------------- Bestenlisten & Archiv

  function overview({ seasonId = null } = {}) {
    const events = eventsFor({ seasonId, finishedOnly: true });
    const players = new Map();
    const row = (uid) => {
      if (!players.has(uid)) {
        players.set(uid, { userId: uid, name: userName(uid), events: 0, titles: 0, finals: 0, points: 0, whitewashes: 0, results: [], ...emptyRecord() });
      }
      return players.get(uid);
    };
    const totals = { events: events.length, matches: 0, legs: 0, whitewashes: 0, deciders: 0 };
    const records = { biggestField: null, mostMatches: null, longestStreak: null, bestQuali: null };
    const archive = [];

    for (const ev of events) {
      const matches = playedMatches(ev);
      const scheme = schemeFor(ev);
      const pts = T.eventEntryPoints(ev, scheme);
      totals.matches += matches.length;
      for (const m of matches) {
        totals.legs += m.legsA + m.legsB;
        if (m.whitewash) totals.whitewashes++;
        if (m.decider) totals.deciders++;
      }
      for (const entry of ev.entries) {
        const p = pts.find((x) => x.entryId === entry.id);
        for (const uid of entry.players) {
          const r = row(uid);
          r.events++;
          r.points += p?.points || 0;
          if (p?.category === 'winner') r.titles++;
          if (p?.category === 'winner' || p?.category === 'final') r.finals++;
        }
      }
      for (const m of matches) {
        for (const eid of [m.a, m.b]) {
          const entry = ev.entries.find((x) => x.id === eid);
          const pp = perspective(m, eid);
          for (const uid of entry?.players || []) {
            const r = row(uid);
            addToRecord(r, pp);
            r.results.push(pp.won);
            if (pp.won && m.whitewash) r.whitewashes++;
          }
        }
      }

      const lots = Object.fromEntries(ev.entries.map((e) => [e.id, e.lot ?? 0]));
      const table = ev.qualifying ? T.qualifyingStandings(ev.entries.map((e) => e.id), ev.qualifying.matches, lots) : [];
      const top = table[0];
      if (top && (!records.bestQuali || top.wins > records.bestQuali.wins || (top.wins === records.bestQuali.wins && top.legDiff > records.bestQuali.legDiff))) {
        const e = ev.entries.find((x) => x.id === top.entryId);
        records.bestQuali = { name: entryName(e), wins: top.wins, losses: top.losses, legDiff: top.legDiff, eventId: ev.id, eventName: ev.name };
      }
      if (!records.biggestField || ev.entries.length > records.biggestField.value) {
        records.biggestField = { value: ev.entries.length, eventId: ev.id, eventName: ev.name, mode: ev.mode };
      }
      if (!records.mostMatches || matches.length > records.mostMatches.value) {
        records.mostMatches = { value: matches.length, eventId: ev.id, eventName: ev.name };
      }

      archive.push({
        eventId: ev.id,
        name: ev.name,
        date: ev.date,
        mode: ev.mode,
        entries: ev.entries.length,
        matches: matches.length,
        legs: matches.reduce((s, m) => s + m.legsA + m.legsB, 0),
        winners: (ev.cups || [])
          .map((c) => {
            const w = T.cupPlacements(c)?.find((p) => p.place === 1);
            const e = w && ev.entries.find((x) => x.id === w.entryId);
            return e ? { cup: c.key, name: entryName(e), userIds: e.players } : null;
          })
          .filter(Boolean),
      });
    }

    const list = [...players.values()].map((r) => {
      const s = streaks(r.results);
      const { results, ...rest } = r;
      return { ...finishRecord(rest), longestWinStreak: s.longestWinStreak };
    });
    for (const r of list) {
      if (!records.longestStreak || r.longestWinStreak > records.longestStreak.value) {
        records.longestStreak = { value: r.longestWinStreak, userId: r.userId, name: r.name };
      }
    }
    if (records.longestStreak && !records.longestStreak.value) records.longestStreak = null;

    const minMatches = list.some((r) => r.played >= 10) ? 10 : 5;
    const top = (key, filter = () => true, n = 8) =>
      list
        .filter((r) => r[key] > 0 && filter(r))
        .sort((a, b) => b[key] - a[key] || b.won - a.won || a.name.localeCompare(b.name))
        .slice(0, n)
        .map((r) => ({ userId: r.userId, name: r.name, value: r[key], played: r.played, won: r.won, events: r.events }));

    return {
      seasonId,
      totals: { ...totals, players: players.size },
      leaderboards: {
        points: top('points'),
        titles: top('titles'),
        wins: top('won'),
        winRate: top('winRate', (r) => r.played >= minMatches),
        legDiff: top('legDiff'),
        events: top('events'),
        whitewashes: top('whitewashes'),
        streak: top('longestWinStreak'),
      },
      minMatches,
      records,
      archive: archive.reverse(),
    };
  }

  // ---------------------------------------------------------------- Turnier-Auswertung

  function eventStats(event) {
    const matches = playedMatches(event);
    const name = (eid) => {
      const e = event.entries.find((x) => x.id === eid);
      return e ? entryName(e) : '?';
    };
    const legs = matches.reduce((s, m) => s + m.legsA + m.legsB, 0);
    const byEntry = new Map(event.entries.map((e) => [e.id, emptyRecord()]));
    for (const m of matches) {
      addToRecord(byEntry.get(m.a), perspective(m, m.a));
      addToRecord(byEntry.get(m.b), perspective(m, m.b));
    }
    const entries = [...byEntry.entries()].map(([id, r]) => ({ entryId: id, name: name(id), ...finishRecord(r) }));

    const upsets = [];
    const paths = [];
    for (const cup of event.cups || []) {
      const seed = (id) => cup.entryIds.indexOf(id) + 1;
      for (const m of cup.matches) {
        if (m.bye || !m.winner) continue;
        const loser = m.winner === m.a ? m.b : m.a;
        const gap = seed(m.winner) - seed(loser);
        if (gap >= 2) {
          upsets.push({ cup: cup.key, stage: m.stage, winner: name(m.winner), winnerSeed: seed(m.winner), loser: name(loser), loserSeed: seed(loser), score: `${Math.max(m.legsA, m.legsB)}:${Math.min(m.legsA, m.legsB)}`, gap });
        }
      }
      const champ = T.cupPlacements(cup)?.find((p) => p.place === 1);
      if (champ) {
        const run = cup.matches
          .filter((m) => !m.bye && m.winner && (m.a === champ.entryId || m.b === champ.entryId))
          .sort((x, y) => x.round - y.round)
          .map((m) => {
            const p = perspective(m, champ.entryId);
            return { stage: m.stage, won: p.won, opponent: name(p.opponent), score: `${p.legsFor}:${p.legsAgainst}` };
          });
        paths.push({ cup: cup.key, name: name(champ.entryId), seed: seed(champ.entryId), size: cup.entryIds.length, lostOnce: run.some((r) => !r.won), matches: run });
      }
    }
    upsets.sort((a, b) => b.gap - a.gap);

    const lots = Object.fromEntries(event.entries.map((e) => [e.id, e.lot ?? 0]));
    const table = event.qualifying ? T.qualifyingStandings(event.entries.map((e) => e.id), event.qualifying.matches, lots) : [];
    const qualiMatches = matches.filter((m) => m.stage === 'Q');
    const perfect = table.filter((r) => r.losses === 0 && r.wins > 0).map((r) => name(r.entryId));

    return {
      totals: {
        matches: matches.length,
        qualiMatches: qualiMatches.length,
        cupMatches: matches.length - qualiMatches.length,
        legs,
        avgLegs: matches.length ? Math.round((legs / matches.length) * 10) / 10 : 0,
        whitewashes: matches.filter((m) => m.whitewash).length,
        deciders: matches.filter((m) => m.decider).length,
        byes: (event.qualifying?.matches || []).filter((m) => m.bye).length + (event.cups || []).reduce((s, c) => s + c.matches.filter((m) => m.bye).length, 0),
      },
      perfectQuali: perfect,
      legLeaders: [...entries].sort((a, b) => b.legsFor - a.legsFor || b.legDiff - a.legDiff).slice(0, 5),
      winLeaders: [...entries].sort((a, b) => b.won - a.won || b.legDiff - a.legDiff).slice(0, 5),
      upsets: upsets.slice(0, 6),
      championPaths: paths,
    };
  }

  return { playerStats, overview, eventStats };
}

module.exports = { createStats, playedMatches };
