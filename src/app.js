'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./tournament');
const { newId, hashPassword, verifyPassword } = require('./store');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const STATUSES = ['registration', 'qualifying', 'cups', 'finished'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function intIn(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function oddBestOf(v, fallback) {
  const n = intIn(v, 1, 21, fallback);
  return n % 2 === 1 ? n : n + 1;
}

function createApp(store, { publicDir, rng = Math.random } = {}) {
  const db = store.data;
  const routes = [];

  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$'
    );
    routes.push({ method, re, keys, handler });
  };

  // ------------------------------------------------------------------ helpers

  const userById = (id) => db.users.find((u) => u.id === id);
  const publicUser = (u) =>
    u && { id: u.id, name: u.name, username: u.username || null, role: u.role, guest: !!u.guest };

  const requireUser = (ctx) => ctx.user || fail(401, 'Bitte zuerst anmelden');
  const requireAdmin = (ctx) => {
    requireUser(ctx);
    if (ctx.user.role !== 'admin') fail(403, 'Nur für Administratoren');
    return ctx.user;
  };

  const getEvent = (id) => db.events.find((e) => e.id === id) || fail(404, 'Termin nicht gefunden');
  const getSeason = (id) => db.seasons.find((s) => s.id === id) || fail(404, 'Season nicht gefunden');

  const entryName = (entry) =>
    entry.teamName || entry.players.map((pid) => userById(pid)?.name || '?').join(' & ');
  const entrySize = (event) => (event.mode === 'double' ? 2 : 1);
  const isComplete = (event, entry) => entry.players.length === entrySize(event);
  const findEntryOf = (event, userId) => event.entries.find((e) => e.players.includes(userId));

  function findMatch(event, matchId) {
    const q = event.qualifying?.matches.find((m) => m.id === matchId);
    if (q) return { match: q, cup: null };
    for (const cup of event.cups || []) {
      const m = cup.matches.find((x) => x.id === matchId);
      if (m) return { match: m, cup };
    }
    fail(404, 'Spiel nicht gefunden');
  }

  function bestOfFor(event, match) {
    if (match.stage === 'Q') return event.bestOf.quali;
    if (match.stage === 'F') return event.bestOf.final;
    return event.bestOf.cup;
  }

  function matchEditable(event, match, cup) {
    if (match.bye) return false;
    if (!cup) return event.status === 'qualifying';
    return ['cups', 'finished'].includes(event.status) && match.round === T.currentRound(cup);
  }

  function seasonScheme(event) {
    const season = db.seasons.find((s) => s.id === event.seasonId);
    return T.mergePoints(season?.points);
  }

  function eventSummary(event) {
    const season = db.seasons.find((s) => s.id === event.seasonId);
    return {
      id: event.id,
      name: event.name,
      date: event.date,
      location: event.location,
      mode: event.mode,
      status: event.status,
      seasonId: event.seasonId,
      seasonName: season?.name || null,
      maxEntries: event.maxEntries,
      entryCount: event.entries.length,
      winners: (event.cups || [])
        .map((c) => {
          const p = T.cupPlacements(c);
          const w = p && p.find((x) => x.place === 1);
          const e = w && event.entries.find((x) => x.id === w.entryId);
          return e ? { cup: c.name, name: entryName(e) } : null;
        })
        .filter(Boolean),
    };
  }

  function eventView(event, me) {
    const decorate = (m, cup) => ({ ...m, bestOf: bestOfFor(event, m), editable: matchEditable(event, m, cup) });
    const lots = Object.fromEntries(event.entries.map((e) => [e.id, e.lot ?? 0]));
    const view = {
      ...eventSummary(event),
      notes: event.notes || '',
      qualiRounds: event.qualiRounds,
      bestOf: event.bestOf,
      numCups: event.numCups || null,
      defaultCupCount: T.defaultCupCount(event.entries.length),
      maxCupCount: T.maxCupCount(event.entries.length),
      myEntryId: me ? findEntryOf(event, me.id)?.id || null : null,
      entries: event.entries.map((e) => ({
        id: e.id,
        name: entryName(e),
        teamName: e.teamName || '',
        complete: isComplete(event, e),
        players: e.players.map((pid) => ({ id: pid, name: userById(pid)?.name || '?' })),
      })),
      qualifying: null,
      cups: [],
      points: null,
    };
    if (event.qualifying) {
      view.qualifying = {
        matches: event.qualifying.matches.map((m) => decorate(m, null)),
        standings: T.qualifyingStandings(
          event.entries.map((e) => e.id),
          event.qualifying.matches,
          lots
        ),
      };
    }
    view.cups = (event.cups || []).map((cup) => ({
      key: cup.key,
      name: cup.name,
      entryIds: cup.entryIds,
      phase: T.cupPhase(cup),
      round: T.currentRound(cup),
      canUndo: canUndo(cup),
      matches: cup.matches.map((m) => decorate(m, cup)),
      placements: T.cupPlacements(cup),
    }));
    if (event.status !== 'registration') view.points = T.eventEntryPoints(event, seasonScheme(event));
    return view;
  }

  function canUndo(cup) {
    const r = T.currentRound(cup);
    return r > 1 && !cup.matches.some((m) => m.round === r && !m.bye && m.winner);
  }

  function seasonStandings(season) {
    const scheme = T.mergePoints(season.points);
    const events = db.events
      .filter((e) => e.seasonId === season.id && e.status === 'finished')
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const rows = new Map();
    const row = (uid) => {
      if (!rows.has(uid)) {
        rows.set(uid, {
          userId: uid,
          name: userById(uid)?.name || '?',
          points: 0,
          single: 0,
          double: 0,
          events: 0,
          qualiWins: 0,
          titles: 0,
          finals: 0,
          perEvent: {},
        });
      }
      return rows.get(uid);
    };
    for (const ev of events) {
      for (const p of T.eventEntryPoints(ev, scheme)) {
        const entry = ev.entries.find((e) => e.id === p.entryId);
        for (const uid of entry.players) {
          const r = row(uid);
          r.points += p.points;
          r[ev.mode] += p.points;
          r.events++;
          r.qualiWins += p.qualiWins;
          if (p.category === 'winner') r.titles++;
          if (p.category === 'winner' || p.category === 'final') r.finals++;
          r.perEvent[ev.id] = { points: p.points, cup: p.cup, place: p.place };
        }
      }
    }
    const list = [...rows.values()].sort(
      (a, b) => b.points - a.points || b.titles - a.titles || b.qualiWins - a.qualiWins || a.name.localeCompare(b.name)
    );
    let lastPts = null;
    let lastRank = 0;
    list.forEach((r, i) => {
      r.rank = r.points === lastPts ? lastRank : i + 1;
      lastPts = r.points;
      lastRank = r.rank;
    });
    return {
      events: events.map((e) => ({ id: e.id, name: e.name, date: e.date, mode: e.mode })),
      rows: list,
    };
  }

  function seasonView(s) {
    return {
      ...s,
      points: T.mergePoints(s.points),
      eventCount: db.events.filter((e) => e.seasonId === s.id).length,
    };
  }

  function createSession(res, user) {
    const now = Date.now();
    db.sessions = db.sessions.filter((s) => s.expires > now);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ token, userId: user.id, expires: now + SESSION_MS });
    res.setHeader(
      'Set-Cookie',
      `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`
    );
  }

  function readEventFields(body, event) {
    const out = {};
    if ('name' in body) out.name = str(body.name, 100) || fail(400, 'Name fehlt');
    if ('date' in body) out.date = str(body.date, 10);
    if ('location' in body) out.location = str(body.location, 100);
    if ('notes' in body) out.notes = str(body.notes, 2000);
    if ('seasonId' in body) {
      out.seasonId = body.seasonId || null;
      if (out.seasonId) getSeason(out.seasonId);
    }
    if ('maxEntries' in body) out.maxEntries = body.maxEntries ? intIn(body.maxEntries, 2, 512, null) : null;
    const locked = event && event.status !== 'registration';
    if ('mode' in body) {
      if (!['single', 'double'].includes(body.mode)) fail(400, 'Ungültiger Modus');
      if (event && body.mode !== event.mode) {
        if (locked || event.entries.length) fail(400, 'Modus kann nach der ersten Anmeldung nicht mehr geändert werden');
      }
      out.mode = body.mode;
    }
    if ('qualiRounds' in body) {
      const v = intIn(body.qualiRounds, 1, 15, 5);
      if (locked && v !== event.qualiRounds) fail(400, 'Vorrunde läuft bereits');
      out.qualiRounds = v;
    }
    if (body.bestOf && typeof body.bestOf === 'object') {
      const prev = event?.bestOf || { quali: 3, cup: 3, final: 5 };
      out.bestOf = {
        quali: oddBestOf(body.bestOf.quali, prev.quali),
        cup: oddBestOf(body.bestOf.cup, prev.cup),
        final: oddBestOf(body.bestOf.final, prev.final),
      };
      if (locked && JSON.stringify(out.bestOf) !== JSON.stringify(prev)) {
        fail(400, 'Best-of kann nach Start der Vorrunde nicht mehr geändert werden');
      }
    }
    return out;
  }

  function readPoints(p) {
    if (!p || typeof p !== 'object') return T.mergePoints();
    const num = (v, d) => intIn(v, 0, 1000, d);
    const base = T.mergePoints(p);
    const cups = {};
    for (const def of T.CUP_DEFS) {
      const c = base.cups[def.key];
      cups[def.key] = {
        winner: num(c.winner, 0),
        final: num(c.final, 0),
        semi: num(c.semi, 0),
        other: num(c.other, 0),
      };
    }
    return { participation: num(base.participation, 0), qualiWin: num(base.qualiWin, 0), cups };
  }

  function addEntry(event, playerIds, teamName) {
    if (event.status !== 'registration') fail(400, 'Anmeldung ist geschlossen');
    if (event.maxEntries && event.entries.length >= event.maxEntries) fail(400, 'Termin ist ausgebucht');
    const uniq = [...new Set(playerIds)];
    if (!uniq.length || uniq.length > entrySize(event)) fail(400, 'Ungültige Spieleranzahl');
    for (const pid of uniq) {
      const u = userById(pid) || fail(400, 'Spieler nicht gefunden');
      if (findEntryOf(event, pid)) fail(400, `${u.name} ist bereits angemeldet`);
    }
    const entry = { id: newId(), players: uniq, teamName: str(teamName, 60), registeredAt: new Date().toISOString() };
    event.entries.push(entry);
    return entry;
  }

  function finishIfDone(event) {
    if (event.cups?.length && event.cups.every((c) => T.cupPhase(c) === 'done')) event.status = 'finished';
  }

  // ------------------------------------------------------------------ auth

  on('GET', '/api/me', (ctx) => ({ user: publicUser(ctx.user), needsSetup: db.users.every((u) => u.guest) }));

  on('POST', '/api/register', (ctx, res) => {
    const username = str(ctx.body.username, 40).toLowerCase();
    const name = str(ctx.body.name, 60);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail(400, 'Benutzername: 3–40 Zeichen (a–z, 0–9, _ . -)');
    if (!name) fail(400, 'Anzeigename fehlt');
    if (password.length < 6) fail(400, 'Passwort muss mindestens 6 Zeichen haben');
    if (db.users.some((u) => u.username === username)) fail(400, 'Benutzername ist bereits vergeben');
    const first = !db.users.some((u) => !u.guest);
    const user = {
      id: newId(),
      username,
      name,
      password: hashPassword(password),
      role: first ? 'admin' : 'player',
      guest: false,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    createSession(res, user);
    return { user: publicUser(user) };
  });

  on('POST', '/api/login', (ctx, res) => {
    const username = str(ctx.body.username, 40).toLowerCase();
    const user = db.users.find((u) => u.username === username && !u.guest);
    if (!user || !verifyPassword(String(ctx.body.password || ''), user.password)) {
      fail(401, 'Benutzername oder Passwort falsch');
    }
    createSession(res, user);
    return { user: publicUser(user) };
  });

  on('POST', '/api/logout', (ctx, res) => {
    db.sessions = db.sessions.filter((s) => s.token !== ctx.token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  on('PUT', '/api/me', (ctx) => {
    const user = requireUser(ctx);
    if ('name' in ctx.body) user.name = str(ctx.body.name, 60) || fail(400, 'Anzeigename fehlt');
    if (ctx.body.newPassword) {
      if (!verifyPassword(String(ctx.body.currentPassword || ''), user.password)) fail(400, 'Aktuelles Passwort falsch');
      if (String(ctx.body.newPassword).length < 6) fail(400, 'Passwort muss mindestens 6 Zeichen haben');
      user.password = hashPassword(String(ctx.body.newPassword));
    }
    return { user: publicUser(user) };
  });

  // ------------------------------------------------------------------ users

  on('GET', '/api/users', (ctx) => {
    requireUser(ctx);
    return db.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name));
  });

  on('POST', '/api/users/guest', (ctx) => {
    requireAdmin(ctx);
    const name = str(ctx.body.name, 60) || fail(400, 'Name fehlt');
    const user = { id: newId(), username: null, name, password: null, role: 'player', guest: true, createdAt: new Date().toISOString() };
    db.users.push(user);
    return publicUser(user);
  });

  on('PUT', '/api/users/:id', (ctx) => {
    requireAdmin(ctx);
    const user = userById(ctx.params.id) || fail(404, 'Spieler nicht gefunden');
    if ('name' in ctx.body) user.name = str(ctx.body.name, 60) || fail(400, 'Name fehlt');
    if ('role' in ctx.body) {
      if (!['admin', 'player'].includes(ctx.body.role)) fail(400, 'Ungültige Rolle');
      if (user.guest && ctx.body.role === 'admin') fail(400, 'Gastspieler können keine Admins sein');
      if (user.role === 'admin' && ctx.body.role !== 'admin' && db.users.filter((u) => u.role === 'admin').length === 1) {
        fail(400, 'Es muss mindestens einen Admin geben');
      }
      user.role = ctx.body.role;
    }
    return publicUser(user);
  });

  on('DELETE', '/api/users/:id', (ctx) => {
    requireAdmin(ctx);
    const user = userById(ctx.params.id) || fail(404, 'Spieler nicht gefunden');
    if (!user.guest) fail(400, 'Nur Gastspieler können gelöscht werden');
    if (db.events.some((e) => findEntryOf(e, user.id))) fail(400, 'Spieler ist bei einem Termin eingetragen');
    db.users.splice(db.users.indexOf(user), 1);
    return { ok: true };
  });

  // ------------------------------------------------------------------ seasons

  on('GET', '/api/seasons', () =>
    db.seasons.map(seasonView).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
  );

  on('POST', '/api/seasons', (ctx) => {
    requireAdmin(ctx);
    const season = {
      id: newId(),
      name: str(ctx.body.name, 100) || fail(400, 'Name fehlt'),
      startDate: str(ctx.body.startDate, 10),
      endDate: str(ctx.body.endDate, 10),
      active: !db.seasons.some((s) => s.active) || !!ctx.body.active,
      points: readPoints(ctx.body.points),
      createdAt: new Date().toISOString(),
    };
    if (season.active) db.seasons.forEach((s) => (s.active = false));
    db.seasons.push(season);
    return seasonView(season);
  });

  on('PUT', '/api/seasons/:id', (ctx) => {
    requireAdmin(ctx);
    const s = getSeason(ctx.params.id);
    if ('name' in ctx.body) s.name = str(ctx.body.name, 100) || fail(400, 'Name fehlt');
    if ('startDate' in ctx.body) s.startDate = str(ctx.body.startDate, 10);
    if ('endDate' in ctx.body) s.endDate = str(ctx.body.endDate, 10);
    if ('points' in ctx.body) s.points = readPoints(ctx.body.points);
    if (ctx.body.active === true) {
      db.seasons.forEach((x) => (x.active = false));
      s.active = true;
    } else if (ctx.body.active === false) {
      s.active = false;
    }
    return seasonView(s);
  });

  on('DELETE', '/api/seasons/:id', (ctx) => {
    requireAdmin(ctx);
    const s = getSeason(ctx.params.id);
    if (db.events.some((e) => e.seasonId === s.id)) fail(400, 'Season enthält noch Termine');
    db.seasons.splice(db.seasons.indexOf(s), 1);
    return { ok: true };
  });

  on('GET', '/api/seasons/:id/standings', (ctx) => {
    const s = getSeason(ctx.params.id);
    return { season: seasonView(s), ...seasonStandings(s) };
  });

  // ------------------------------------------------------------------ events

  on('GET', '/api/events', () =>
    db.events.map(eventSummary).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  );

  on('GET', '/api/events/:id', (ctx) => eventView(getEvent(ctx.params.id), ctx.user));

  on('POST', '/api/events', (ctx) => {
    requireAdmin(ctx);
    const fields = readEventFields({ mode: 'single', bestOf: {}, ...ctx.body });
    const event = {
      id: newId(),
      name: fields.name || fail(400, 'Name fehlt'),
      date: fields.date || '',
      location: fields.location || '',
      notes: fields.notes || '',
      seasonId: fields.seasonId ?? db.seasons.find((s) => s.active)?.id ?? null,
      mode: fields.mode,
      maxEntries: fields.maxEntries ?? null,
      qualiRounds: fields.qualiRounds ?? 5,
      bestOf: fields.bestOf,
      status: 'registration',
      entries: [],
      qualifying: null,
      cups: [],
      createdAt: new Date().toISOString(),
    };
    db.events.push(event);
    return eventView(event, ctx.user);
  });

  on('PUT', '/api/events/:id', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    Object.assign(event, readEventFields(ctx.body, event));
    return eventView(event, ctx.user);
  });

  on('DELETE', '/api/events/:id', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    db.events.splice(db.events.indexOf(event), 1);
    return { ok: true };
  });

  // Selbst anmelden (optional mit Partner im Doppel)
  on('POST', '/api/events/:id/register', (ctx) => {
    const user = requireUser(ctx);
    const event = getEvent(ctx.params.id);
    const players = [user.id];
    if (event.mode === 'double' && ctx.body.partnerId) players.push(String(ctx.body.partnerId));
    addEntry(event, players, ctx.body.teamName);
    return eventView(event, user);
  });

  // Admin trägt Spieler/Team ein
  on('POST', '/api/events/:id/entries', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    const ids = Array.isArray(ctx.body.playerIds) ? ctx.body.playerIds.map(String) : [];
    addEntry(event, ids, ctx.body.teamName);
    return eventView(event, ctx.user);
  });

  // Einem Team mit nur einem Spieler beitreten (Doppel)
  on('POST', '/api/events/:id/entries/:entryId/join', (ctx) => {
    const user = requireUser(ctx);
    const event = getEvent(ctx.params.id);
    if (event.status !== 'registration') fail(400, 'Anmeldung ist geschlossen');
    const entry = event.entries.find((e) => e.id === ctx.params.entryId) || fail(404, 'Team nicht gefunden');
    if (entry.players.length >= entrySize(event)) fail(400, 'Team ist bereits vollständig');
    if (findEntryOf(event, user.id)) fail(400, 'Du bist bereits angemeldet');
    entry.players.push(user.id);
    return eventView(event, user);
  });

  on('DELETE', '/api/events/:id/entries/:entryId', (ctx) => {
    const user = requireUser(ctx);
    const event = getEvent(ctx.params.id);
    if (event.status !== 'registration') fail(400, 'Anmeldung ist geschlossen');
    const entry = event.entries.find((e) => e.id === ctx.params.entryId) || fail(404, 'Anmeldung nicht gefunden');
    if (user.role === 'admin' && !entry.players.includes(user.id)) {
      event.entries.splice(event.entries.indexOf(entry), 1);
    } else if (entry.players.includes(user.id)) {
      entry.players = entry.players.filter((p) => p !== user.id);
      if (!entry.players.length) event.entries.splice(event.entries.indexOf(entry), 1);
      else entry.teamName = '';
    } else {
      fail(403, 'Keine Berechtigung');
    }
    return eventView(event, user);
  });

  on('PUT', '/api/events/:id/entries/:entryId', (ctx) => {
    const user = requireUser(ctx);
    const event = getEvent(ctx.params.id);
    const entry = event.entries.find((e) => e.id === ctx.params.entryId) || fail(404, 'Anmeldung nicht gefunden');
    if (user.role !== 'admin' && !entry.players.includes(user.id)) fail(403, 'Keine Berechtigung');
    entry.teamName = str(ctx.body.teamName, 60);
    return eventView(event, user);
  });

  // Einzelne Doppel-Spieler zufällig zu Teams zusammenlosen
  on('POST', '/api/events/:id/pair-solos', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    if (event.mode !== 'double' || event.status !== 'registration') fail(400, 'Nur im Doppel während der Anmeldung');
    const solos = T.shuffle(event.entries.filter((e) => e.players.length === 1), rng);
    for (let i = 0; i + 1 < solos.length; i += 2) {
      solos[i].players.push(...solos[i + 1].players);
      solos[i].teamName = '';
      event.entries.splice(event.entries.indexOf(solos[i + 1]), 1);
    }
    return eventView(event, ctx.user);
  });

  on('POST', '/api/events/:id/start-qualifying', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    if (event.status !== 'registration') fail(400, 'Vorrunde wurde bereits gestartet');
    if (event.entries.length < 2) fail(400, 'Mindestens 2 Teilnehmer erforderlich');
    if (event.entries.some((e) => !isComplete(event, e))) fail(400, 'Es gibt noch unvollständige Doppel-Teams');
    const lots = T.shuffle(event.entries.map((_, i) => i), rng);
    event.entries.forEach((e, i) => (e.lot = lots[i]));
    event.qualifying = {
      matches: T.generateQualifying(event.entries.map((e) => e.id), event.qualiRounds, rng),
    };
    event.cups = [];
    event.status = 'qualifying';
    return eventView(event, ctx.user);
  });

  on('POST', '/api/events/:id/start-cups', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    if (event.status !== 'qualifying') fail(400, 'Vorrunde läuft nicht');
    if (event.qualifying.matches.some((m) => !m.winner)) fail(400, 'Es fehlen noch Ergebnisse der Vorrunde');
    const n = event.entries.length;
    const numCups = intIn(ctx.body.numCups, 1, T.maxCupCount(n), T.defaultCupCount(n));
    const lots = Object.fromEntries(event.entries.map((e) => [e.id, e.lot ?? 0]));
    const ranked = T.qualifyingStandings(event.entries.map((e) => e.id), event.qualifying.matches, lots).map(
      (r) => r.entryId
    );
    event.numCups = numCups;
    event.cups = T.splitIntoCups(ranked, numCups).map((c) => T.createCup(c, c.entryIds, rng));
    event.status = 'cups';
    finishIfDone(event);
    return eventView(event, ctx.user);
  });

  on('POST', '/api/events/:id/matches/:matchId/result', (ctx) => {
    const user = requireUser(ctx);
    const event = getEvent(ctx.params.id);
    const { match, cup } = findMatch(event, ctx.params.matchId);
    const players = [match.a, match.b]
      .map((eid) => event.entries.find((e) => e.id === eid))
      .filter(Boolean)
      .flatMap((e) => e.players);
    if (user.role !== 'admin' && !players.includes(user.id)) fail(403, 'Nur Admins oder Spieler dieses Spiels');
    if (!matchEditable(event, match, cup)) {
      fail(400, 'Dieses Spiel kann nicht mehr geändert werden (ggf. letzte Runde zurücknehmen)');
    }
    try {
      T.applyResult(match, Number(ctx.body.legsA), Number(ctx.body.legsB), bestOfFor(event, match));
    } catch (e) {
      fail(400, e.message);
    }
    match.reportedBy = user.id;
    match.reportedAt = new Date().toISOString();
    if (cup) {
      T.advanceCup(cup, rng);
      finishIfDone(event);
    }
    return eventView(event, user);
  });

  on('POST', '/api/events/:id/cups/:cupKey/undo', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    const cup = (event.cups || []).find((c) => c.key === ctx.params.cupKey) || fail(404, 'Cup nicht gefunden');
    try {
      T.undoLastRound(cup);
    } catch (e) {
      fail(400, e.message);
    }
    if (event.status === 'finished') event.status = 'cups';
    return eventView(event, ctx.user);
  });

  on('POST', '/api/events/:id/reset', (ctx) => {
    requireAdmin(ctx);
    const event = getEvent(ctx.params.id);
    const to = ctx.body.to;
    if (!['registration', 'qualifying'].includes(to)) fail(400, 'Ungültiges Ziel');
    if (STATUSES.indexOf(event.status) <= STATUSES.indexOf(to)) fail(400, 'Termin ist nicht weiter fortgeschritten');
    event.cups = [];
    event.numCups = null;
    if (to === 'registration') event.qualifying = null;
    event.status = to;
    return eventView(event, ctx.user);
  });

  // ------------------------------------------------------------------ http

  function serveStatic(req, res, pathname) {
    if (!publicDir) return false;
    let file = path.normalize(path.join(publicDir, decodeURIComponent(pathname)));
    if (!file.startsWith(path.resolve(publicDir))) return false;
    if (pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(publicDir, 'index.html');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1e6) {
          reject(new HttpError(413, 'Anfrage zu groß'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
        return send(res, 404, { error: 'Nicht gefunden' });
      }
      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) return send(res, 404, { error: 'Nicht gefunden' });
      const params = {};
      const m = pathname.match(route.re);
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

      let body = {};
      if (req.method !== 'GET') {
        // Nur JSON akzeptieren (Schutz gegen CSRF über einfache Formulare)
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          fail(415, 'Content-Type application/json erforderlich');
        }
        const raw = await readBody(req);
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          fail(400, 'Ungültiges JSON');
        }
        if (!body || typeof body !== 'object') body = {};
      }

      const token = parseCookies(req.headers.cookie).sid;
      const session = token && db.sessions.find((s) => s.token === token && s.expires > Date.now());
      const user = session ? userById(session.userId) : null;
      const ctx = { params, body, user, token, query: url.searchParams };

      const result = await route.handler(ctx, res);
      if (req.method !== 'GET') store.save();
      send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Interner Fehler' });
    }
  };
}

module.exports = { createApp };
