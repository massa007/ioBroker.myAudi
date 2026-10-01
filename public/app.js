'use strict';

/* ======================================================================
 * Darts Turnierplaner – Frontend (Vanilla JS, Hash-Routing)
 * ==================================================================== */

const $app = document.getElementById('app');
const state = { me: null, needsSetup: false, users: null, event: null, refreshTimer: null };

const STATUS_LABEL = {
  registration: 'Anmeldung offen',
  qualifying: 'Vorrunde',
  cups: 'Cups laufen',
  finished: 'Beendet',
};
const MODE_LABEL = { single: 'Einzel', double: 'Doppel' };
const CUP_NAMES = { pro: 'Pro Cup', advanced: 'Advanced Cup', beginner: 'Beginners Cup' };
const CATEGORY_LABEL = { winner: 'Sieger', final: 'Finalist', semi: 'Halbfinale', other: 'Ausgeschieden' };

// ---------------------------------------------------------------- utils

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtDate(d) {
  if (!d) return 'ohne Datum';
  const [y, m, day] = d.split('-');
  return day && m && y ? `${day}.${m}.${y}` : d;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = ''), isError ? 4500 : 2500);
}

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

const isAdmin = () => state.me?.role === 'admin';

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

function cupTag(key) {
  return key ? `<span class="cup-tag cup-${esc(key)}">${esc(CUP_NAMES[key] || key)}</span>` : '–';
}

function statusBadge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

async function loadUsers(force = false) {
  if (!state.me) return [];
  if (!state.users || force) state.users = await api('GET', '/api/users');
  return state.users;
}

// ---------------------------------------------------------------- chrome

function renderChrome() {
  const hash = location.hash || '#/';
  const links = [
    ['#/', 'Übersicht'],
    ['#/events', 'Termine'],
    ['#/seasons', 'Seasons'],
  ];
  if (state.me) links.push(['#/players', 'Spieler']);
  document.getElementById('nav').innerHTML = links
    .map(([h, l]) => {
      const active = h === '#/' ? hash === '#/' || hash === '' : hash.startsWith(h);
      return `<a href="${h}" class="${active ? 'active' : ''}">${l}</a>`;
    })
    .join('');
  document.getElementById('userbox').innerHTML = state.me
    ? `<a href="#/profile">${esc(state.me.name)}${isAdmin() ? '<span class="badge admin">Admin</span>' : ''}</a>
       <a href="#" data-action="logout">Abmelden</a>`
    : `<a href="#/login">Anmelden</a><a href="#/register">Registrieren</a>`;
}

// ---------------------------------------------------------------- views

async function viewHome() {
  const [events, seasons] = await Promise.all([api('GET', '/api/events'), api('GET', '/api/seasons')]);
  const active = seasons.find((s) => s.active);
  const standings = active ? await api('GET', `/api/seasons/${active.id}/standings`) : null;
  const upcoming = events.filter((e) => e.status !== 'finished').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const finished = events.filter((e) => e.status === 'finished').slice(0, 4);

  return `
    ${state.needsSetup ? `<div class="notice"><strong>Willkommen!</strong> Es gibt noch keinen Account. Der erste registrierte Benutzer wird automatisch Administrator. <a href="#/register">Jetzt registrieren</a></div>` : ''}
    <h1>Übersicht</h1>
    <div class="grid">
      <section class="card">
        <div class="spread"><h2>${active ? esc(active.name) : 'Keine aktive Season'}</h2>${active ? `<a href="#/seasons/${active.id}">Tabelle →</a>` : ''}</div>
        ${
          standings && standings.rows.length
            ? `<table><tbody>${standings.rows
                .slice(0, 8)
                .map((r) => `<tr class="${r.userId === state.me?.id ? 'me' : ''}"><td class="rank">${r.rank}.</td><td>${esc(r.name)}</td><td class="num"><strong>${r.points}</strong> P.</td></tr>`)
                .join('')}</tbody></table>`
            : `<p class="muted">${active ? 'Noch keine abgeschlossenen Termine.' : isAdmin() ? '<a href="#/seasons">Season anlegen</a>' : 'Der Admin hat noch keine Season angelegt.'}</p>`
        }
      </section>
      <section class="card">
        <div class="spread"><h2>Nächste Termine</h2><a href="#/events">Alle →</a></div>
        ${upcoming.length ? `<div class="stack">${upcoming.slice(0, 5).map(eventLine).join('')}</div>` : '<p class="muted">Keine anstehenden Termine.</p>'}
      </section>
      <section class="card">
        <h2>Letzte Sieger</h2>
        ${
          finished.length
            ? `<div class="stack">${finished
                .map(
                  (e) => `<div><a href="#/events/${e.id}"><strong>${esc(e.name)}</strong></a> <span class="muted small">${fmtDate(e.date)}</span>
                    <div class="small">${e.winners.map((w) => `🏆 ${esc(w.cup)}: <strong>${esc(w.name)}</strong>`).join('<br>')}</div></div>`
                )
                .join('')}</div>`
            : '<p class="muted">Noch keine Ergebnisse.</p>'
        }
      </section>
    </div>`;
}

function eventLine(e) {
  return `<div class="spread"><div><a href="#/events/${e.id}"><strong>${esc(e.name)}</strong></a>
    <div class="muted small">${fmtDate(e.date)} · ${MODE_LABEL[e.mode]} · ${e.entryCount}${e.maxEntries ? '/' + e.maxEntries : ''} ${e.mode === 'double' ? 'Teams' : 'Spieler'}</div></div>${statusBadge(e.status)}</div>`;
}

async function viewEvents() {
  const [events, seasons] = await Promise.all([api('GET', '/api/events'), api('GET', '/api/seasons')]);
  return `
    <div class="spread"><h1>Termine</h1></div>
    ${isAdmin() ? `<details class="card"><summary>+ Neuer Termin</summary><div style="margin-top:12px">${eventForm(null, seasons)}</div></details>` : ''}
    ${
      events.length
        ? `<div class="grid">${events
            .map(
              (e) => `<a class="card event-card" href="#/events/${e.id}">
                <div class="spread"><h3>${esc(e.name)}</h3>${statusBadge(e.status)}</div>
                <div class="muted small">${fmtDate(e.date)}${e.location ? ' · ' + esc(e.location) : ''}</div>
                <div class="small">${MODE_LABEL[e.mode]} · ${e.entryCount}${e.maxEntries ? '/' + e.maxEntries : ''} ${e.mode === 'double' ? 'Teams' : 'Spieler'}${e.seasonName ? ' · ' + esc(e.seasonName) : ''}</div>
                ${e.winners.length ? `<div class="small" style="margin-top:6px">${e.winners.map((w) => `🏆 ${esc(w.name)} <span class="muted">(${esc(w.cup)})</span>`).join('<br>')}</div>` : ''}
              </a>`
            )
            .join('')}</div>`
        : '<p class="muted">Noch keine Termine angelegt.</p>'
    }`;
}

function eventForm(ev, seasons) {
  const v = ev || { mode: 'single', qualiRounds: 5, bestOf: { quali: 3, cup: 3, final: 5 }, seasonId: seasons.find((s) => s.active)?.id };
  const locked = ev && ev.status !== 'registration';
  const lockMode = ev && (locked || ev.entries.length > 0);
  const bo = (name, val) =>
    `<select name="bo_${name}" ${locked ? 'disabled' : ''}>${[1, 3, 5, 7, 9, 11, 13]
      .map((n) => `<option value="${n}" ${n === val ? 'selected' : ''}>Best of ${n}</option>`)
      .join('')}</select>`;
  return `<form data-form="${ev ? 'event-edit' : 'event-create'}" class="form-grid">
    <div class="wide"><label>Name</label><input name="name" required maxlength="100" value="${esc(v.name || '')}" placeholder="z. B. Dartsabend Oktober"></div>
    <div><label>Datum</label><input type="date" name="date" value="${esc(v.date || '')}"></div>
    <div><label>Ort</label><input name="location" maxlength="100" value="${esc(v.location || '')}"></div>
    <div><label>Season</label><select name="seasonId"><option value="">– keine –</option>${seasons
      .map((s) => `<option value="${s.id}" ${s.id === v.seasonId ? 'selected' : ''}>${esc(s.name)}</option>`)
      .join('')}</select></div>
    <div><label>Modus</label><select name="mode" ${lockMode ? 'disabled' : ''}>
      <option value="single" ${v.mode === 'single' ? 'selected' : ''}>Einzel</option>
      <option value="double" ${v.mode === 'double' ? 'selected' : ''}>Doppel</option></select></div>
    <div><label>Max. Teilnehmer (leer = unbegrenzt)</label><input type="number" min="2" name="maxEntries" value="${esc(v.maxEntries || '')}"></div>
    <div><label>Vorrunden-Spiele je Teilnehmer</label><input type="number" min="1" max="15" name="qualiRounds" value="${esc(v.qualiRounds)}" ${locked ? 'disabled' : ''}></div>
    <div><label>Vorrunde</label>${bo('quali', v.bestOf.quali)}</div>
    <div><label>Cup-Spiele & Halbfinale</label>${bo('cup', v.bestOf.cup)}</div>
    <div><label>Finale</label>${bo('final', v.bestOf.final)}</div>
    <div class="wide"><label>Notizen</label><textarea name="notes" rows="2" maxlength="2000">${esc(v.notes || '')}</textarea></div>
    <div class="wide row"><button class="primary" type="submit">${ev ? 'Speichern' : 'Termin anlegen'}</button>
    ${ev ? `<button type="button" class="danger" data-action="event-delete">Termin löschen</button>` : ''}</div>
  </form>`;
}

function eventPayload(f) {
  const p = {
    name: f.name,
    date: f.date,
    location: f.location,
    seasonId: f.seasonId || null,
    maxEntries: f.maxEntries ? Number(f.maxEntries) : null,
    notes: f.notes,
  };
  if (f.mode !== undefined) p.mode = f.mode;
  if (f.qualiRounds !== undefined) p.qualiRounds = Number(f.qualiRounds);
  if (f.bo_quali !== undefined) p.bestOf = { quali: Number(f.bo_quali), cup: Number(f.bo_cup), final: Number(f.bo_final) };
  return p;
}

// ---------------------------------------------------------------- event detail

const TABS = [
  ['entries', 'Teilnehmer'],
  ['qualifying', 'Vorrunde'],
  ['cups', 'Cups'],
  ['results', 'Ergebnis & Punkte'],
];

function defaultTab(ev) {
  return { registration: 'entries', qualifying: 'qualifying', cups: 'cups', finished: 'results' }[ev.status];
}

async function viewEvent(id, tab) {
  const ev = await api('GET', `/api/events/${id}`);
  state.event = ev;
  if (state.me) await loadUsers();
  tab = tab || defaultTab(ev);
  const steps = ['registration', 'qualifying', 'cups', 'finished'];
  const cur = steps.indexOf(ev.status);
  const names = entryNames(ev);
  scheduleRefresh(ev);

  let body = '';
  if (tab === 'entries') body = await tabEntries(ev);
  else if (tab === 'qualifying') body = tabQualifying(ev, names);
  else if (tab === 'cups') body = tabCups(ev, names);
  else if (tab === 'results') body = tabResults(ev, names);
  else if (tab === 'settings' && isAdmin()) body = `<div class="card">${eventForm(ev, await api('GET', '/api/seasons'))}</div>${adminResetBox(ev)}`;

  return `
    <div class="spread">
      <div><h1>${esc(ev.name)}</h1>
        <div class="muted">${fmtDate(ev.date)}${ev.location ? ' · ' + esc(ev.location) : ''} · ${MODE_LABEL[ev.mode]}${ev.seasonName ? ` · <a href="#/seasons/${ev.seasonId}">${esc(ev.seasonName)}</a>` : ''}</div>
      </div>${statusBadge(ev.status)}
    </div>
    ${ev.notes ? `<p>${esc(ev.notes)}</p>` : ''}
    <div class="steps">${steps.map((s, i) => `<span class="${i < cur ? 'done' : i === cur ? 'current' : ''}">${i < cur ? '✓ ' : ''}${STATUS_LABEL[s]}</span>`).join('')}</div>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/events/${ev.id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}
      ${isAdmin() ? `<a href="#/events/${ev.id}/settings" class="${tab === 'settings' ? 'active' : ''}">⚙ Einstellungen</a>` : ''}</nav>
    ${body}`;
}

function entryNames(ev) {
  return Object.fromEntries(ev.entries.map((e) => [e.id, e.name]));
}

function isMyEntry(ev, entryId) {
  return !!entryId && ev.myEntryId === entryId;
}

async function tabEntries(ev) {
  const unit = ev.mode === 'double' ? 'Teams' : 'Spieler';
  const users = state.me ? await loadUsers() : [];
  const registered = new Set(ev.entries.flatMap((e) => e.players.map((p) => p.id)));
  const free = users.filter((u) => !registered.has(u.id));
  const open = ev.status === 'registration';
  const full = ev.maxEntries && ev.entries.length >= ev.maxEntries;
  const solos = ev.entries.filter((e) => !e.complete);

  let myBox = '';
  if (open && state.me) {
    if (ev.myEntryId) {
      const mine = ev.entries.find((e) => e.id === ev.myEntryId);
      myBox = `<div class="card"><div class="spread"><div>✅ Du bist angemeldet${ev.mode === 'double' ? ` als <strong>${esc(mine.name)}</strong>${mine.complete ? '' : ' – <em>Partner gesucht</em>'}` : ''}.</div>
        <button class="danger" data-action="entry-remove" data-entry="${mine.id}">Abmelden</button></div>
        ${ev.mode === 'double' && mine.complete ? `<form data-form="team-name" data-entry="${mine.id}" class="row" style="margin-top:10px"><input name="teamName" maxlength="60" placeholder="Teamname (optional)" value="${esc(mine.teamName)}" style="max-width:260px"><button>Speichern</button></form>` : ''}</div>`;
    } else if (full) {
      myBox = `<div class="notice">Dieser Termin ist ausgebucht.</div>`;
    } else if (ev.mode === 'single') {
      myBox = `<div class="card"><div class="spread"><div>Du bist noch nicht angemeldet.</div><button class="primary" data-action="register-self">Jetzt anmelden</button></div></div>`;
    } else {
      myBox = `<div class="card"><h3>Für das Doppel anmelden</h3>
        <form data-form="register-double" class="form-grid">
          <div><label>Partner</label><select name="partnerId"><option value="">– Partner gesucht –</option>${free
            .filter((u) => u.id !== state.me.id)
            .map((u) => `<option value="${u.id}">${esc(u.name)}</option>`)
            .join('')}</select></div>
          <div><label>Teamname (optional)</label><input name="teamName" maxlength="60"></div>
          <div style="align-self:end"><button class="primary">Anmelden</button></div>
        </form>
        ${solos.length ? `<p class="small muted" style="margin-top:12px">Oder einem Spieler ohne Partner beitreten:</p><div class="row">${solos.map((s) => `<button class="small" data-action="join-entry" data-entry="${s.id}">Mit ${esc(s.name)} spielen</button>`).join('')}</div>` : ''}
      </div>`;
    }
  } else if (open && !state.me) {
    myBox = `<div class="notice"><a href="#/login">Melde dich an</a> oder <a href="#/register">registriere dich</a>, um teilzunehmen.</div>`;
  }

  const adminBox =
    isAdmin() && open
      ? `<div class="card"><h3>Admin: Teilnehmer verwalten</h3>
        <form data-form="admin-add-entry" class="form-grid">
          <div><label>Spieler${ev.mode === 'double' ? ' 1' : ''}</label><select name="p1" required><option value="">– wählen –</option>${free.map((u) => `<option value="${u.id}">${esc(u.name)}${u.guest ? ' (Gast)' : ''}</option>`).join('')}</select></div>
          ${ev.mode === 'double' ? `<div><label>Spieler 2 (optional)</label><select name="p2"><option value="">– Partner gesucht –</option>${free.map((u) => `<option value="${u.id}">${esc(u.name)}${u.guest ? ' (Gast)' : ''}</option>`).join('')}</select></div>` : ''}
          <div style="align-self:end"><button>Eintragen</button></div>
        </form>
        <form data-form="guest-add" class="row" style="margin-top:12px">
          <input name="name" placeholder="Neuer Gastspieler (ohne Account)" maxlength="60" required style="max-width:280px">
          <label class="checkbox"><input type="checkbox" name="register" checked> direkt eintragen</label>
          <button>Gast anlegen</button>
        </form>
        <div class="row" style="margin-top:16px">
          ${ev.mode === 'double' && solos.length > 1 ? `<button data-action="pair-solos">🎲 Einzelspieler zu Teams auslosen (${solos.length})</button>` : ''}
          <button class="primary" data-action="start-qualifying" ${ev.entries.length < 2 || solos.length ? 'disabled' : ''}>▶ Vorrunde starten (${ev.qualiRounds} Spiele je ${ev.mode === 'double' ? 'Team' : 'Spieler'})</button>
        </div>
        ${solos.length ? `<p class="small muted">Vor dem Start müssen alle Teams vollständig sein.</p>` : ''}
      </div>`
      : '';

  return `${myBox}${adminBox}
    <div class="card"><h2>${ev.entries.length}${ev.maxEntries ? ' / ' + ev.maxEntries : ''} ${unit}</h2>
      ${
        ev.entries.length
          ? `<ul class="entry-list">${ev.entries
              .map(
                (e, i) => `<li><span><span class="muted">${i + 1}.</span> <strong>${esc(e.name)}</strong>
                  ${ev.mode === 'double' && e.teamName ? `<span class="muted small">(${e.players.map((p) => esc(p.name)).join(' & ')})</span>` : ''}
                  ${!e.complete ? '<span class="badge">Partner gesucht</span>' : ''}</span>
                  ${isAdmin() && open && e.id !== ev.myEntryId ? `<button class="small danger" data-action="entry-remove" data-entry="${e.id}">Entfernen</button>` : ''}</li>`
              )
              .join('')}</ul>`
          : '<p class="muted">Noch keine Anmeldungen.</p>'
      }
    </div>`;
}

function matchCard(ev, m, names, opts = {}) {
  const nameA = names[m.a] || '?';
  const nameB = m.bye ? 'Freilos' : names[m.b] || '?';
  const done = !!m.winner;
  const mine = isMyEntry(ev, m.a) || isMyEntry(ev, m.b);
  const canEdit = m.editable && state.me && (isAdmin() || mine);
  const sideCls = (id) => (!done ? '' : m.winner === id ? 'win' : 'lose');
  const stageLabel = { Q: `Runde ${m.round}`, W: 'Winners', L: 'Losers', SF: 'Halbfinale', F: 'Finale' }[m.stage];
  const form =
    canEdit && (!done || opts.editing === m.id)
      ? `<form class="result-form" data-form="result" data-match="${m.id}">
          <input type="number" name="legsA" min="0" max="${Math.ceil(m.bestOf / 2)}" value="${done ? m.legsA : ''}" aria-label="Legs ${esc(nameA)}" required>
          <span>:</span>
          <input type="number" name="legsB" min="0" max="${Math.ceil(m.bestOf / 2)}" value="${done ? m.legsB : ''}" aria-label="Legs ${esc(nameB)}" required>
          <button class="small primary">✓</button>
        </form>`
      : '';
  return `<div class="match ${done ? 'done' : 'open'} ${m.bye ? 'bye' : ''} ${mine ? 'mine' : ''}">
    <div class="meta"><span>${opts.label || stageLabel}${m.bye ? '' : ` · Bo${m.bestOf}`}</span>
      ${canEdit && done && opts.editing !== m.id ? `<button class="small" data-action="edit-result" data-match="${m.id}">Ändern</button>` : ''}</div>
    <div class="side ${sideCls(m.a)}"><span>${esc(nameA)}</span><span class="legs">${done && !m.bye ? m.legsA : ''}</span></div>
    <div class="side ${m.bye ? '' : sideCls(m.b)}"><span>${esc(nameB)}</span><span class="legs">${done && !m.bye ? m.legsB : ''}</span></div>
    ${form}
  </div>`;
}

function tabQualifying(ev, names) {
  if (!ev.qualifying) return `<p class="muted">Die Vorrunde wurde noch nicht gestartet.</p>`;
  const q = ev.qualifying;
  const rounds = [...new Set(q.matches.map((m) => m.round))].sort((a, b) => a - b);
  const openCount = q.matches.filter((m) => !m.winner).length;
  const n = ev.entries.length;
  const preview = previewCupSizes(n, ev.numCups || ev.defaultCupCount);
  const cuts = new Set();
  let acc = 0;
  preview.forEach((s, i) => {
    acc += s;
    if (i < preview.length - 1) cuts.add(acc);
  });
  const cupOf = (rank) => {
    let a = 0;
    for (let i = 0; i < preview.length; i++) {
      a += preview[i];
      if (rank <= a) return ['pro', 'advanced', 'beginner'][i];
    }
  };

  const adminBox =
    isAdmin() && ev.status === 'qualifying'
      ? `<div class="card"><h3>Admin: Cups starten</h3>
        <form data-form="start-cups" class="row">
          <label class="checkbox">Anzahl Cups:
            <select name="numCups" style="width:auto">${[1, 2, 3]
              .filter((k) => k <= ev.maxCupCount)
              .map((k) => `<option value="${k}" ${k === ev.defaultCupCount ? 'selected' : ''}>${k}</option>`)
              .join('')}</select></label>
          <button class="primary" ${openCount ? 'disabled' : ''}>▶ Cups auslosen</button>
          ${openCount ? `<span class="muted small">Noch ${openCount} offene Spiele</span>` : ''}
        </form>
        <p class="small muted">Oberes Drittel → Pro Cup, mittleres → Advanced Cup, unteres → Beginners Cup.</p></div>`
      : '';

  return `${adminBox}
    <div class="card"><h2>Tabelle der Vorrunde</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>${ev.mode === 'double' ? 'Team' : 'Spieler'}</th><th class="num">Sp.</th><th class="num">S</th><th class="num">N</th><th class="num">Legs</th><th class="num">Diff</th><th>${ev.cups.length ? 'Cup' : 'Prognose'}</th></tr></thead>
        <tbody>${q.standings
          .map((r) => {
            const cupKey = ev.cups.length ? ev.cups.find((c) => c.entryIds.includes(r.entryId))?.key : cupOf(r.rank);
            return `<tr class="${isMyEntry(ev, r.entryId) ? 'me' : ''} ${cuts.has(r.rank) ? 'cut' : ''}">
              <td class="rank">${r.rank}</td><td>${esc(names[r.entryId])}</td>
              <td class="num">${r.played + r.byes}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td>
              <td class="num">${r.legsFor}:${r.legsAgainst}</td><td class="num">${r.legDiff > 0 ? '+' : ''}${r.legDiff}</td>
              <td>${cupTag(cupKey)}</td></tr>`;
          })
          .join('')}</tbody></table></div>
      <p class="small muted">Sortierung: Siege, Leg-Differenz, gewonnene Legs, Los. Freilose zählen als Sieg.</p>
    </div>
    ${rounds
      .map(
        (r) => `<div class="bracket-section"><h3>Runde ${r}</h3><div class="matches">${q.matches
          .filter((m) => m.round === r)
          .map((m) => matchCard(ev, m, names, { editing: state.editing }))
          .join('')}</div></div>`
      )
      .join('')}`;
}

function previewCupSizes(n, k) {
  k = Math.max(1, Math.min(k, 3, Math.max(1, Math.floor(n / 2))));
  const base = Math.floor(n / k);
  const rem = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

function tabCups(ev, names) {
  if (!ev.cups.length) return `<p class="muted">Die Cups werden nach der Vorrunde ausgelost.</p>`;
  const open = ev.cups.flatMap((c) => c.matches.filter((m) => !m.winner).map((m) => ({ m, c })));
  return `
    ${open.length ? `<div class="card"><h2>Jetzt zu spielen (${open.length})</h2><div class="matches">${open.map(({ m, c }) => matchCard(ev, m, names, { label: `${CUP_NAMES[c.key]} · ${stageName(m)}` })).join('')}</div></div>` : ''}
    ${ev.cups.map((c) => cupBlock(ev, c, names)).join('')}`;
}

function stageName(m) {
  return { W: 'Winners Bracket', L: 'Losers Bracket', SF: 'Halbfinale', F: 'Finale' }[m.stage];
}

function cupBlock(ev, cup, names) {
  const rounds = (stage) => [...new Set(cup.matches.filter((m) => m.stage === stage).map((m) => m.round))].sort((a, b) => a - b);
  const columns = (stage, label) =>
    rounds(stage)
      .map(
        (r, i) => `<div class="col"><div class="col-title">${label} ${i + 1}</div>${cup.matches
          .filter((m) => m.stage === stage && m.round === r)
          .map((m) => matchCard(ev, m, names, { editing: state.editing }))
          .join('')}</div>`
      )
      .join('');
  const finals = ['SF', 'F']
    .map((s) => {
      const ms = cup.matches.filter((m) => m.stage === s);
      return ms.length ? `<div class="col"><div class="col-title">${s === 'SF' ? 'Halbfinale' : 'Finale'}</div>${ms.map((m) => matchCard(ev, m, names, { editing: state.editing })).join('')}</div>` : '';
    })
    .join('');
  const champ = cup.placements?.find((p) => p.place === 1);
  const lb = columns('L', 'Runde');

  return `<section class="card">
    <div class="spread cup-header cup-${cup.key}">
      <div><h2>${esc(cup.name)}</h2><div class="muted small">${cup.entryIds.length} ${ev.mode === 'double' ? 'Teams' : 'Spieler'} · Setzliste nach Vorrunde</div></div>
      <div class="row">${champ ? `<strong>🏆 ${esc(names[champ.entryId])}</strong>` : ''}
        ${isAdmin() && cup.canUndo ? `<button class="small" data-action="undo-round" data-cup="${cup.key}" title="Löscht die zuletzt ausgeloste Runde, um Ergebnisse der Runde davor zu korrigieren">↶ Letzte Runde zurücknehmen</button>` : ''}</div>
    </div>
    <div class="bracket-section" style="margin-top:14px"><h3>Winners Bracket</h3><div class="bracket">${columns('W', 'Runde') || '<p class="muted small">–</p>'}</div></div>
    <div class="bracket-section"><h3>Losers Bracket</h3><div class="bracket">${lb || '<p class="muted small">Noch keine Spiele – wer im Winners Bracket verliert, landet hier.</p>'}</div></div>
    ${finals ? `<div class="bracket-section"><h3>Finalrunde (K.o.)</h3><div class="bracket">${finals}</div></div>` : ''}
  </section>`;
}

function tabResults(ev, names) {
  if (!ev.points) return `<p class="muted">Ergebnisse gibt es nach dem Start der Vorrunde.</p>`;
  const podiums = ev.cups
    .filter((c) => c.placements)
    .map(
      (c) => `<div class="card"><h2 class="cup-${c.key}">${esc(c.name)}</h2><div class="podium">${c.placements
        .filter((p) => p.place <= 3)
        .map((p) => `<div>${p.place === 1 ? '🥇' : p.place === 2 ? '🥈' : '🥉'} <strong>${esc(names[p.entryId])}</strong><div class="muted small">${CATEGORY_LABEL[p.category]}</div></div>`)
        .join('')}</div></div>`
    )
    .join('');
  const rows = [...ev.points].sort((a, b) => b.points - a.points || (a.place ?? 99) - (b.place ?? 99));
  return `${podiums ? `<div class="grid">${podiums}</div>` : ''}
    <div class="card"><h2>Punkte dieses Termins</h2>
      ${ev.status !== 'finished' ? '<p class="small muted">Vorläufig – fließt erst nach Abschluss aller Cups in die Season-Wertung ein.</p>' : ''}
      ${!ev.seasonId ? '<p class="small muted">Dieser Termin gehört zu keiner Season.</p>' : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>${ev.mode === 'double' ? 'Team' : 'Spieler'}</th><th>Cup</th><th class="num">Platz</th><th class="num">Vorrunden-Siege</th><th class="num">Punkte${ev.mode === 'double' ? ' je Spieler' : ''}</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr class="${isMyEntry(ev, r.entryId) ? 'me' : ''}"><td>${esc(names[r.entryId])}</td><td>${cupTag(r.cup)}</td>
              <td class="num">${r.place ? r.place + '.' : '–'}</td><td class="num">${r.qualiWins}</td><td class="num"><strong>${r.points}</strong></td></tr>`
          )
          .join('')}</tbody></table></div></div>`;
}

function adminResetBox(ev) {
  if (ev.status === 'registration') return '';
  return `<div class="card"><h3>Turnier zurücksetzen</h3><p class="small muted">Achtung: Ergebnisse gehen dabei verloren.</p>
    <div class="row">
      ${['cups', 'finished'].includes(ev.status) ? `<button class="danger" data-action="reset" data-to="qualifying">Cups löschen (zurück zur Vorrunde)</button>` : ''}
      <button class="danger" data-action="reset" data-to="registration">Vorrunde löschen (zurück zur Anmeldung)</button>
    </div></div>`;
}

function scheduleRefresh(ev) {
  clearInterval(state.refreshTimer);
  if (ev.status === 'qualifying' || ev.status === 'cups') {
    state.refreshTimer = setInterval(() => {
      const a = document.activeElement;
      const busy = a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
      const typed = [...document.querySelectorAll('.result-form input')].some((i) => i.value !== '' && !i.defaultValue);
      if (!busy && !typed && !state.editing && location.hash.startsWith(`#/events/${ev.id}`)) route(true);
    }, 15000);
  }
}

// ---------------------------------------------------------------- seasons

async function viewSeasons() {
  const seasons = await api('GET', '/api/seasons');
  return `<h1>Seasons</h1>
    ${isAdmin() ? `<details class="card"><summary>+ Neue Season</summary><div style="margin-top:12px">${seasonForm(null)}</div></details>` : ''}
    ${
      seasons.length
        ? `<div class="grid">${seasons
            .map(
              (s) => `<a class="card event-card" href="#/seasons/${s.id}"><div class="spread"><h3>${esc(s.name)}</h3>${s.active ? '<span class="badge registration">aktiv</span>' : ''}</div>
              <div class="muted small">${seasonRange(s)}${s.eventCount} Termine</div></a>`
            )
            .join('')}</div>`
        : '<p class="muted">Noch keine Seasons.</p>'
    }`;
}

function seasonRange(s) {
  if (!s.startDate && !s.endDate) return '';
  return `${s.startDate ? fmtDate(s.startDate) : '…'} – ${s.endDate ? fmtDate(s.endDate) : '…'} · `;
}

function seasonForm(s) {
  const p = s?.points || {
    participation: 1,
    qualiWin: 1,
    cups: {
      pro: { winner: 20, final: 15, semi: 10, other: 5 },
      advanced: { winner: 12, final: 9, semi: 6, other: 3 },
      beginner: { winner: 8, final: 6, semi: 4, other: 2 },
    },
  };
  const num = (name, v) => `<input type="number" min="0" max="1000" name="${name}" value="${esc(v)}">`;
  return `<form data-form="${s ? 'season-edit' : 'season-create'}" class="stack">
    <div class="form-grid">
      <div class="wide"><label>Name</label><input name="name" required maxlength="100" value="${esc(s?.name || '')}" placeholder="z. B. Season 2026/27"></div>
      <div><label>Start</label><input type="date" name="startDate" value="${esc(s?.startDate || '')}"></div>
      <div><label>Ende</label><input type="date" name="endDate" value="${esc(s?.endDate || '')}"></div>
      <div style="align-self:end"><label class="checkbox"><input type="checkbox" name="active" ${!s || s.active ? 'checked' : ''}> Aktive Season</label></div>
    </div>
    <h3>Punktevergabe (pro Spieler)</h3>
    <div class="form-grid">
      <div><label>Teilnahme</label>${num('participation', p.participation)}</div>
      <div><label>Je Sieg in der Vorrunde</label>${num('qualiWin', p.qualiWin)}</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Cup</th><th>Sieger</th><th>Finalist</th><th>Halbfinale</th><th>Sonst. Teilnahme</th></tr></thead>
      <tbody>${['pro', 'advanced', 'beginner']
        .map((k) => `<tr><td>${cupTag(k)}</td>${['winner', 'final', 'semi', 'other'].map((c) => `<td>${num(`${k}_${c}`, p.cups[k][c])}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>
    <div class="row"><button class="primary">${s ? 'Speichern' : 'Season anlegen'}</button>
      ${s && !s.eventCount ? '<button type="button" class="danger" data-action="season-delete">Season löschen</button>' : ''}</div>
  </form>`;
}

function seasonPayload(f) {
  const n = (v) => Number(v) || 0;
  const cups = {};
  for (const k of ['pro', 'advanced', 'beginner']) {
    cups[k] = { winner: n(f[`${k}_winner`]), final: n(f[`${k}_final`]), semi: n(f[`${k}_semi`]), other: n(f[`${k}_other`]) };
  }
  return { name: f.name, startDate: f.startDate, endDate: f.endDate, active: !!f.active, points: { participation: n(f.participation), qualiWin: n(f.qualiWin), cups } };
}

async function viewSeason(id) {
  const data = await api('GET', `/api/seasons/${id}/standings`);
  const s = data.season;
  state.season = s;
  const filter = state.seasonFilter || 'points';
  const rows = [...data.rows].sort((a, b) => b[filter] - a[filter] || b.points - a.points);
  let rank = 0;
  let last = null;
  rows.forEach((r, i) => {
    if (r[filter] !== last) rank = i + 1;
    r._rank = rank;
    last = r[filter];
  });
  const p = s.points;
  return `<div class="spread"><div><h1>${esc(s.name)}</h1><div class="muted">${seasonRange(s)}${s.active ? '<span class="badge registration">aktiv</span>' : ''}</div></div></div>
    <div class="card">
      <div class="spread"><h2>Gesamtwertung</h2>
        <div class="row small">Wertung:
          ${[['points', 'Gesamt'], ['single', 'Einzel'], ['double', 'Doppel']]
            .map(([k, l]) => `<button class="small ${filter === k ? 'primary' : ''}" data-action="season-filter" data-filter="${k}">${l}</button>`)
            .join('')}</div></div>
      ${
        rows.length
          ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Spieler</th><th class="num">Punkte</th><th class="num">Einzel</th><th class="num">Doppel</th><th class="num">Termine</th><th class="num">Titel</th><th class="num">Finals</th><th class="num">VR-Siege</th>
          ${data.events.map((e) => `<th class="num" title="${esc(e.name)}"><a href="#/events/${e.id}">${esc(fmtDate(e.date).slice(0, 6) || e.name)}</a><br><span class="small">${e.mode === 'double' ? 'D' : 'E'}</span></th>`).join('')}</tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr class="${r.userId === state.me?.id ? 'me' : ''}"><td class="rank">${r._rank}.</td><td>${esc(r.name)}</td>
              <td class="num"><strong>${r.points}</strong></td><td class="num">${r.single}</td><td class="num">${r.double}</td><td class="num">${r.events}</td>
              <td class="num">${r.titles}</td><td class="num">${r.finals}</td><td class="num">${r.qualiWins}</td>
              ${data.events.map((e) => {
                const pe = r.perEvent[e.id];
                return `<td class="num" title="${pe ? `${CUP_NAMES[pe.cup] || ''} Platz ${pe.place ?? '–'}` : ''}">${pe ? `<span class="cup-${pe.cup}">${pe.points}</span>` : '<span class="muted">–</span>'}</td>`;
              }).join('')}</tr>`
            )
            .join('')}</tbody></table></div>`
          : '<p class="muted">Noch keine abgeschlossenen Termine in dieser Season.</p>'
      }
    </div>
    <div class="card"><h2>Punktevergabe</h2>
      <p>Teilnahme: <strong>${p.participation}</strong> · je Vorrunden-Sieg: <strong>${p.qualiWin}</strong> (Freilose ausgenommen). Im Doppel erhalten beide Spieler die Punkte.</p>
      <div class="table-wrap"><table><thead><tr><th>Cup</th><th class="num">Sieger</th><th class="num">Finalist</th><th class="num">Halbfinale</th><th class="num">Sonstige</th></tr></thead>
      <tbody>${['pro', 'advanced', 'beginner'].map((k) => `<tr><td>${cupTag(k)}</td>${['winner', 'final', 'semi', 'other'].map((c) => `<td class="num">${p.cups[k][c]}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    </div>
    ${isAdmin() ? `<details class="card"><summary>⚙ Season bearbeiten</summary><div style="margin-top:12px">${seasonForm(s)}</div></details>` : ''}`;
}

// ---------------------------------------------------------------- players / auth

async function viewPlayers() {
  if (!state.me) return viewLogin();
  const users = await loadUsers(true);
  return `<h1>Spieler</h1>
    ${isAdmin() ? `<div class="card"><form data-form="guest-add" class="row"><input name="name" placeholder="Name des Gastspielers" maxlength="60" required style="max-width:280px"><button>Gastspieler anlegen</button></form>
      <p class="small muted">Gastspieler haben keinen Login und werden vom Admin zu Terminen eingetragen.</p></div>` : ''}
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Benutzername</th><th>Rolle</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr class="${u.id === state.me.id ? 'me' : ''}"><td>${esc(u.name)}</td><td class="muted">${u.username ? '@' + esc(u.username) : 'Gast'}</td>
          <td>${u.role === 'admin' ? '<span class="badge admin">Admin</span>' : u.guest ? '<span class="badge">Gast</span>' : '<span class="badge">Spieler</span>'}</td>
          ${
            isAdmin()
              ? `<td class="right"><button class="small" data-action="user-rename" data-user="${u.id}">Umbenennen</button>
            ${!u.guest ? `<button class="small" data-action="user-role" data-user="${u.id}" data-role="${u.role === 'admin' ? 'player' : 'admin'}">${u.role === 'admin' ? 'Admin entziehen' : 'Zum Admin'}</button>` : `<button class="small danger" data-action="user-delete" data-user="${u.id}">Löschen</button>`}</td>`
              : ''
          }</tr>`
        )
        .join('')}</tbody></table></div></div>`;
}

function viewLogin() {
  return `<div class="card auth-box"><h1>Anmelden</h1>
    <form data-form="login" class="stack">
      <div><label>Benutzername</label><input name="username" autocomplete="username" required></div>
      <div><label>Passwort</label><input type="password" name="password" autocomplete="current-password" required></div>
      <button class="primary">Anmelden</button>
      <p class="small muted">Noch kein Account? <a href="#/register">Registrieren</a></p>
    </form></div>`;
}

function viewRegister() {
  return `<div class="card auth-box"><h1>Registrieren</h1>
    ${state.needsSetup ? '<div class="notice small">Du bist der erste Benutzer und wirst Administrator.</div>' : ''}
    <form data-form="register" class="stack">
      <div><label>Anzeigename</label><input name="name" maxlength="60" required placeholder="z. B. Max Mustermann"></div>
      <div><label>Benutzername</label><input name="username" autocomplete="username" required pattern="[a-zA-Z0-9_.\\-]{3,40}" title="3–40 Zeichen: Buchstaben, Zahlen, _ . -"></div>
      <div><label>Passwort (min. 6 Zeichen)</label><input type="password" name="password" minlength="6" autocomplete="new-password" required></div>
      <button class="primary">Account erstellen</button>
      <p class="small muted">Schon registriert? <a href="#/login">Anmelden</a></p>
    </form></div>`;
}

function viewProfile() {
  if (!state.me) return viewLogin();
  return `<div class="card auth-box"><h1>Profil</h1>
    <form data-form="profile" class="stack">
      <div><label>Anzeigename</label><input name="name" maxlength="60" required value="${esc(state.me.name)}"></div>
      <div><label>Aktuelles Passwort (nur für Passwortwechsel)</label><input type="password" name="currentPassword" autocomplete="current-password"></div>
      <div><label>Neues Passwort</label><input type="password" name="newPassword" minlength="6" autocomplete="new-password"></div>
      <button class="primary">Speichern</button>
    </form></div>`;
}

// ---------------------------------------------------------------- router

async function route(silent = false) {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!silent) {
    clearInterval(state.refreshTimer);
    state.editing = null;
  }
  renderChrome();
  const scrollY = window.scrollY;
  try {
    let html;
    if (!parts.length) html = await viewHome();
    else if (parts[0] === 'events' && parts[1]) html = await viewEvent(parts[1], parts[2]);
    else if (parts[0] === 'events') html = await viewEvents();
    else if (parts[0] === 'seasons' && parts[1]) html = await viewSeason(parts[1]);
    else if (parts[0] === 'seasons') html = await viewSeasons();
    else if (parts[0] === 'players') html = await viewPlayers();
    else if (parts[0] === 'login') html = viewLogin();
    else if (parts[0] === 'register') html = viewRegister();
    else if (parts[0] === 'profile') html = viewProfile();
    else html = '<h1>Seite nicht gefunden</h1>';
    $app.innerHTML = html;
    if (silent) window.scrollTo(0, scrollY);
  } catch (e) {
    $app.innerHTML = `<div class="card"><h2>Fehler</h2><p>${esc(e.message)}</p></div>`;
  }
}

async function refreshMe() {
  const r = await api('GET', '/api/me');
  state.me = r.user;
  state.needsSetup = r.needsSetup;
  state.users = null;
}

// ---------------------------------------------------------------- actions

const evUrl = (suffix = '') => `/api/events/${state.event.id}${suffix}`;

async function afterEventChange(msg) {
  state.users = null;
  state.editing = null;
  if (msg) toast(msg);
  await route(true);
}

const actions = {
  async logout() {
    await api('POST', '/api/logout');
    await refreshMe();
    location.hash = '#/';
    toast('Abgemeldet');
    route();
  },
  async 'register-self'() {
    await api('POST', evUrl('/register'));
    afterEventChange('Angemeldet!');
  },
  async 'join-entry'(el) {
    await api('POST', evUrl(`/entries/${el.dataset.entry}/join`));
    afterEventChange('Team beigetreten');
  },
  async 'entry-remove'(el) {
    if (!confirm('Anmeldung wirklich entfernen?')) return;
    await api('DELETE', evUrl(`/entries/${el.dataset.entry}`));
    afterEventChange('Anmeldung entfernt');
  },
  async 'pair-solos'() {
    await api('POST', evUrl('/pair-solos'));
    afterEventChange('Teams ausgelost');
  },
  async 'start-qualifying'() {
    if (!confirm('Vorrunde starten? Danach sind keine Anmeldungen mehr möglich.')) return;
    await api('POST', evUrl('/start-qualifying'));
    location.hash = `#/events/${state.event.id}/qualifying`;
    toast('Vorrunde ausgelost');
  },
  async 'edit-result'(el) {
    state.editing = el.dataset.match;
    const scrollY = window.scrollY;
    const parts = location.hash.split('/');
    $app.innerHTML = await viewEvent(state.event.id, parts[3]);
    window.scrollTo(0, scrollY);
    document.querySelector(`form[data-match="${el.dataset.match}"] input`)?.focus();
  },
  async 'undo-round'(el) {
    if (!confirm('Die zuletzt ausgeloste Runde dieses Cups löschen?')) return;
    await api('POST', evUrl(`/cups/${el.dataset.cup}/undo`));
    afterEventChange('Runde zurückgenommen');
  },
  async reset(el) {
    const msg = el.dataset.to === 'registration' ? 'Vorrunde und Cups löschen und zurück zur Anmeldung?' : 'Alle Cups löschen und zurück zur Vorrunde?';
    if (!confirm(msg + ' Ergebnisse gehen verloren.')) return;
    await api('POST', evUrl('/reset'), { to: el.dataset.to });
    location.hash = `#/events/${state.event.id}`;
    toast('Zurückgesetzt');
  },
  async 'event-delete'() {
    if (!confirm(`Termin „${state.event.name}“ endgültig löschen?`)) return;
    await api('DELETE', evUrl());
    location.hash = '#/events';
    toast('Termin gelöscht');
  },
  async 'season-filter'(el) {
    state.seasonFilter = el.dataset.filter;
    route(true);
  },
  async 'season-delete'() {
    if (!confirm('Season löschen?')) return;
    await api('DELETE', `/api/seasons/${state.season.id}`);
    location.hash = '#/seasons';
  },
  async 'user-rename'(el) {
    const u = state.users.find((x) => x.id === el.dataset.user);
    const name = prompt('Neuer Name', u?.name || '');
    if (!name) return;
    await api('PUT', `/api/users/${el.dataset.user}`, { name });
    route(true);
  },
  async 'user-role'(el) {
    await api('PUT', `/api/users/${el.dataset.user}`, { role: el.dataset.role });
    toast('Rolle geändert');
    route(true);
  },
  async 'user-delete'(el) {
    if (!confirm('Gastspieler löschen?')) return;
    await api('DELETE', `/api/users/${el.dataset.user}`);
    route(true);
  },
};

const forms = {
  async login(f) {
    await api('POST', '/api/login', f);
    await refreshMe();
    toast(`Willkommen, ${state.me.name}!`);
    location.hash = '#/';
  },
  async register(f) {
    await api('POST', '/api/register', f);
    await refreshMe();
    toast(state.me.role === 'admin' ? 'Account erstellt – du bist Administrator.' : 'Account erstellt!');
    location.hash = '#/';
  },
  async profile(f) {
    await api('PUT', '/api/me', f);
    await refreshMe();
    toast('Profil gespeichert');
    route();
  },
  async 'event-create'(f) {
    const ev = await api('POST', '/api/events', eventPayload(f));
    toast('Termin angelegt');
    location.hash = `#/events/${ev.id}`;
  },
  async 'event-edit'(f) {
    await api('PUT', evUrl(), eventPayload(f));
    afterEventChange('Gespeichert');
  },
  async 'register-double'(f) {
    await api('POST', evUrl('/register'), { partnerId: f.partnerId || null, teamName: f.teamName });
    afterEventChange('Angemeldet!');
  },
  async 'team-name'(f, form) {
    await api('PUT', evUrl(`/entries/${form.dataset.entry}`), { teamName: f.teamName });
    afterEventChange('Teamname gespeichert');
  },
  async 'admin-add-entry'(f) {
    const ids = [f.p1, f.p2].filter(Boolean);
    await api('POST', evUrl('/entries'), { playerIds: ids });
    afterEventChange('Eingetragen');
  },
  async 'guest-add'(f) {
    const u = await api('POST', '/api/users/guest', { name: f.name });
    if (f.register && state.event && location.hash.startsWith('#/events/')) {
      await api('POST', evUrl('/entries'), { playerIds: [u.id] });
    }
    state.users = null;
    toast('Gastspieler angelegt');
    route(true);
  },
  async 'start-cups'(f) {
    if (!confirm(`Vorrunde abschließen und ${f.numCups} Cup(s) auslosen?`)) return;
    await api('POST', evUrl('/start-cups'), { numCups: Number(f.numCups) });
    location.hash = `#/events/${state.event.id}/cups`;
    toast('Cups ausgelost');
  },
  async result(f, form) {
    await api('POST', evUrl(`/matches/${form.dataset.match}/result`), { legsA: Number(f.legsA), legsB: Number(f.legsB) });
    afterEventChange('Ergebnis gespeichert');
  },
  async 'season-create'(f) {
    const s = await api('POST', '/api/seasons', seasonPayload(f));
    toast('Season angelegt');
    location.hash = `#/seasons/${s.id}`;
  },
  async 'season-edit'(f) {
    await api('PUT', `/api/seasons/${state.season.id}`, seasonPayload(f));
    toast('Season gespeichert');
    route(true);
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  if (el.disabled) return;
  el.disabled = true;
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(err.message, true);
  } finally {
    el.disabled = false;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  const btn = form.querySelector('button:not([type=button])');
  if (btn) btn.disabled = true;
  try {
    await forms[form.dataset.form](formData(form), form);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

window.addEventListener('hashchange', () => route());

(async () => {
  try {
    await refreshMe();
  } catch {
    /* Server nicht erreichbar – Fehler zeigt route() */
  }
  route();
})();
