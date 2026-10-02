'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./tournament');
const { newId, hashPassword, verifyPassword } = require('./store');
const { createStats } = require('./stats');
const { RateLimiter, securityHeaders, clientIp, isHttps, sameOrigin, hashToken, safeEqual } = require('./security');

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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 100 * 1024;
const PASSWORD_MIN = 8;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ungültiges Cookie ignorieren */
    }
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

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) fail(400, `Passwort muss mindestens ${PASSWORD_MIN} Zeichen haben`);
  if (pw.length > 200) fail(400, 'Passwort ist zu lang');
  return pw;
}

/**
 * @param {object} opts
 * @param {string} [opts.publicDir]   Verzeichnis der Oberfläche
 * @param {string} [opts.setupToken]  Einmal-Code, der für den ersten Admin-Account nötig ist
 * @param {boolean} [opts.trustProxy] X-Forwarded-* Header eines Reverse Proxys auswerten
 * @param {boolean} [opts.secureCookies] Cookies immer mit Secure-Flag setzen
 */
function createApp(store, { publicDir, rng = Math.random, setupToken = null, trustProxy = false, secureCookies = false } = {}) {
  const db = store.data;
  const routes = [];
  const limits = {
    loginIp: new RateLimiter(30, 15 * 60 * 1000),
    loginUser: new RateLimiter(5, 15 * 60 * 1000),
    register: new RateLimiter(5, 60 * 60 * 1000),
    writes: new RateLimiter(300, 60 * 1000),
  };
  const hasAdmin = () => db.users.some((u) => u.role === 'admin');
  const stats = createStats(db);

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
  const publicUser = (u, viewer) =>
    u && {
      id: u.id,
      name: u.name,
      // Benutzernamen (= Login-Namen) sehen nur Admins und der Benutzer selbst
      username: viewer && (viewer.role === 'admin' || viewer.id === u.id) ? u.username || null : null,
      role: u.role,
      guest: !!u.guest,
      approved: u.guest || u.role === 'admin' || u.approved !== false,
    };

  const requireUser = (ctx) => ctx.user || fail(401, 'Bitte zuerst anmelden');
  const isApproved = (u) => u.role === 'admin' || !db.settings.requireApproval || u.approved !== false;
  const requireApproved = (ctx) => {
    const u = requireUser(ctx);
    if (!isApproved(u)) fail(403, 'Dein Account wurde noch nicht von einem Admin freigeschaltet');
    return u;
  };
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

  function cookieFlags(ctx) {
    return `HttpOnly; SameSite=Lax; Path=/${secureCookies || ctx.https ? '; Secure' : ''}`;
  }

  function createSession(ctx, res, user) {
    const now = Date.now();
    db.sessions = db.sessions.filter((s) => s.expires > now);
    if (ctx.sessionHash) db.sessions = db.sessions.filter((s) => s.tokenHash !== ctx.sessionHash);
    const token = crypto.randomBytes(32).toString('hex');
    // In der Datenbank liegt nur der Hash – ein geleaktes Backup erlaubt keine Übernahme von Sitzungen
    db.sessions.push({ tokenHash: hashToken(token), userId: user.id, expires: now + SESSION_MS });
    res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(ctx)}; Max-Age=${SESSION_MS / 1000}`);
  }

  function clearSessionCookie(ctx, res) {
    res.setHeader('Set-Cookie', `sid=; ${cookieFlags(ctx)}; Max-Age=0`);
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
      if (!isApproved(u)) fail(400, `${u.name} ist noch nicht freigeschaltet`);
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

  on('GET', '/api/me', (ctx) => ({
    user: publicUser(ctx.user, ctx.user),
    approved: ctx.user ? isApproved(ctx.user) : null,
    needsSetup: !hasAdmin(),
    registrationOpen: db.settings.registrationOpen,
    requireApproval: db.settings.requireApproval,
  }));

  on('POST', '/api/register', (ctx, res) => {
    const setup = !hasAdmin();
    if (!setup && !db.settings.registrationOpen) fail(403, 'Die Registrierung ist derzeit geschlossen');
    if (limits.register.blocked(ctx.ip)) fail(429, 'Zu viele Registrierungen von dieser Adresse – bitte später erneut versuchen');
    if (setup) {
      // Ohne Setup-Code könnte jeder Besucher einer frisch installierten Seite Admin werden
      if (!setupToken || !safeEqual(str(ctx.body.setupCode, 100), setupToken)) {
        fail(403, 'Für den ersten Admin-Account wird der Setup-Code aus dem Server-Log benötigt');
      }
    }
    const username = str(ctx.body.username, 40).toLowerCase();
    const name = str(ctx.body.name, 60);
    if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail(400, 'Benutzername: 3–40 Zeichen (a–z, 0–9, _ . -)');
    if (!name) fail(400, 'Anzeigename fehlt');
    const password = checkPassword(ctx.body.password);
    if (db.users.some((u) => u.username === username)) fail(400, 'Benutzername ist bereits vergeben');
    limits.register.hit(ctx.ip);
    const user = {
      id: newId(),
      username,
      name,
      password: hashPassword(password),
      role: setup ? 'admin' : 'player',
      guest: false,
      approved: setup || !db.settings.requireApproval,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    createSession(ctx, res, user);
    return { user: publicUser(user, user), approved: isApproved(user) };
  });

  on('POST', '/api/login', (ctx, res) => {
    const username = str(ctx.body.username, 40).toLowerCase();
    const userKey = `${ctx.ip}|${username}`;
    if (limits.loginIp.blocked(ctx.ip) || limits.loginUser.blocked(userKey)) {
      const wait = Math.max(limits.loginIp.retryAfter(ctx.ip), limits.loginUser.retryAfter(userKey));
      fail(429, `Zu viele Fehlversuche – bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen`);
    }
    const user = db.users.find((u) => u.username === username && !u.guest);
    const ok = verifyPassword(String(ctx.body.password || '').slice(0, 200), user?.password);
    if (!user || !ok) {
      limits.loginIp.hit(ctx.ip);
      limits.loginUser.hit(userKey);
      fail(401, 'Benutzername oder Passwort falsch');
    }
    limits.loginUser.reset(userKey);
    createSession(ctx, res, user);
    return { user: publicUser(user, user), approved: isApproved(user) };
  });

  on('POST', '/api/logout', (ctx, res) => {
    if (ctx.sessionHash) db.sessions = db.sessions.filter((s) => s.tokenHash !== ctx.sessionHash);
    clearSessionCookie(ctx, res);
    return { ok: true };
  });

  on('PUT', '/api/me', (ctx) => {
    const user = requireUser(ctx);
    if ('name' in ctx.body) user.name = str(ctx.body.name, 60) || fail(400, 'Anzeigename fehlt');
    if (ctx.body.newPassword) {
      if (!verifyPassword(String(ctx.body.currentPassword || '').slice(0, 200), user.password)) fail(400, 'Aktuelles Passwort falsch');
      user.password = hashPassword(checkPassword(ctx.body.newPassword));
      // Alle anderen Sitzungen dieses Benutzers beenden
      db.sessions = db.sessions.filter((s) => s.userId !== user.id || s.tokenHash === ctx.sessionHash);
    }
    return { user: publicUser(user, user) };
  });

  // ------------------------------------------------------------------ settings

  on('GET', '/api/settings', (ctx) => {
    requireAdmin(ctx);
    return db.settings;
  });

  on('PUT', '/api/settings', (ctx) => {
    requireAdmin(ctx);
    if ('registrationOpen' in ctx.body) db.settings.registrationOpen = !!ctx.body.registrationOpen;
    if ('requireApproval' in ctx.body) db.settings.requireApproval = !!ctx.body.requireApproval;
    return db.settings;
  });

  // ------------------------------------------------------------------ users

  on('GET', '/api/users', (ctx) => {
    requireUser(ctx);
    let list = db.users;
    // Nicht freigeschaltete Accounts sieht nur der Admin
    if (ctx.user.role !== 'admin') list = list.filter((u) => u.id === ctx.user.id || isApproved(u) || u.guest);
    return list.map((u) => publicUser(u, ctx.user)).sort((a, b) => a.name.localeCompare(b.name));
  });

  on('POST', '/api/users/guest', (ctx) => {
    requireAdmin(ctx);
    const name = str(ctx.body.name, 60) || fail(400, 'Name fehlt');
    const user = { id: newId(), username: null, name, password: null, role: 'player', guest: true, approved: true, createdAt: new Date().toISOString() };
    db.users.push(user);
    return publicUser(user, ctx.user);
  });

  on('PUT', '/api/users/:id', (ctx) => {
    requireAdmin(ctx);
    const user = userById(ctx.params.id) || fail(404, 'Spieler nicht gefunden');
    if ('name' in ctx.body) user.name = str(ctx.body.name, 60) || fail(400, 'Name fehlt');
    if ('approved' in ctx.body) user.approved = !!ctx.body.approved;
    if ('role' in ctx.body) {
      if (!['admin', 'player'].includes(ctx.body.role)) fail(400, 'Ungültige Rolle');
      if (user.guest && ctx.body.role === 'admin') fail(400, 'Gastspieler können keine Admins sein');
      if (user.role === 'admin' && ctx.body.role !== 'admin' && db.users.filter((u) => u.role === 'admin').length === 1) {
        fail(400, 'Es muss mindestens einen Admin geben');
      }
      user.role = ctx.body.role;
      if (user.role === 'admin') user.approved = true;
    }
    if (ctx.body.password) {
      if (user.guest) fail(400, 'Gastspieler haben kein Passwort');
      user.password = hashPassword(checkPassword(ctx.body.password));
      db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    }
    return publicUser(user, ctx.user);
  });

  on('DELETE', '/api/users/:id', (ctx) => {
    requireAdmin(ctx);
    const user = userById(ctx.params.id) || fail(404, 'Spieler nicht gefunden');
    if (user.role === 'admin') fail(400, 'Admins können nicht gelöscht werden – zuerst Admin-Rechte entziehen');
    if (db.events.some((e) => findEntryOf(e, user.id))) fail(400, 'Spieler ist bei einem Termin eingetragen');
    db.users.splice(db.users.indexOf(user), 1);
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
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

  // ------------------------------------------------------------------ stats

  on('GET', '/api/stats', () => {
    const players = new Set();
    let matches = 0;
    let legs = 0;
    for (const e of db.events) {
      if (e.status === 'registration') continue;
      e.entries.forEach((x) => x.players.forEach((p) => players.add(p)));
      const all = [...(e.qualifying?.matches || []), ...(e.cups || []).flatMap((c) => c.matches)];
      for (const m of all) {
        if (m.bye || !m.winner) continue;
        matches++;
        legs += (m.legsA || 0) + (m.legsB || 0);
      }
    }
    return { players: players.size, events: db.events.length, matches, legs, seasons: db.seasons.length };
  });

  const seasonParam = (ctx) => {
    const id = ctx.query.get('season');
    return id && db.seasons.some((s) => s.id === id) ? id : null;
  };

  on('GET', '/api/stats/overview', (ctx) => stats.overview({ seasonId: seasonParam(ctx) }));

  on('GET', '/api/players/:id/stats', (ctx) => {
    const res = stats.playerStats(ctx.params.id, { seasonId: seasonParam(ctx) });
    if (!res) fail(404, 'Spieler nicht gefunden');
    return res;
  });

  on('GET', '/api/events/:id/stats', (ctx) => stats.eventStats(getEvent(ctx.params.id)));

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
    const user = requireApproved(ctx);
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
    const user = requireApproved(ctx);
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
    const user = requireApproved(ctx);
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
    const user = requireApproved(ctx);
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

  const publicRoot = publicDir ? path.resolve(publicDir) : null;

  function serveStatic(req, res, pathname) {
    if (!publicRoot) return false;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    let file = path.resolve(publicRoot, '.' + path.posix.normalize('/' + rel));
    const inside = path.relative(publicRoot, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return false;
    let isFile = false;
    try {
      isFile = fs.statSync(file).isFile();
    } catch {
      /* existiert nicht */
    }
    if (!isFile) {
      // Unbekannte Pfade mit Dateiendung -> 404, sonst SPA-Einstieg
      if (path.extname(rel)) return false;
      file = path.join(publicRoot, 'index.html');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(file).pipe(res);
    return true;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'Anfrage zu groß'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  return async function handle(req, res) {
    const https = isHttps(req, trustProxy);
    securityHeaders(res, { https });
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Ungültige URL' });
    }
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
        return send(res, 404, { error: 'Nicht gefunden' });
      }
      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) return send(res, 404, { error: 'Nicht gefunden' });
      const params = {};
      const m = pathname.match(route.re);
      try {
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        fail(400, 'Ungültige URL');
      }

      const ip = clientIp(req, trustProxy);
      let body = {};
      if (req.method !== 'GET') {
        // CSRF-Schutz: nur JSON (erzwingt CORS-Preflight) und nur von der eigenen Seite
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          fail(415, 'Content-Type application/json erforderlich');
        }
        if (!sameOrigin(req, trustProxy)) fail(403, 'Anfrage von fremder Seite abgelehnt');
        if (limits.writes.blocked(ip)) fail(429, 'Zu viele Anfragen – bitte kurz warten');
        limits.writes.hit(ip);
        const raw = await readBody(req);
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          fail(400, 'Ungültiges JSON');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      }

      const token = parseCookies(req.headers.cookie).sid;
      const sessionHash = token && /^[a-f0-9]{64}$/.test(token) ? hashToken(token) : null;
      const session = sessionHash && db.sessions.find((s) => s.tokenHash === sessionHash && s.expires > Date.now());
      const user = session ? userById(session.userId) || null : null;
      const ctx = { params, body, user, sessionHash: session ? sessionHash : null, ip, https, query: url.searchParams };

      const result = await route.handler(ctx, res);
      if (req.method !== 'GET') store.save();
      send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        if (res.headersSent) return res.end();
        return send(res, err.status, { error: err.message });
      }
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Interner Fehler' });
      else res.end();
    }
  };
}

module.exports = { createApp };
