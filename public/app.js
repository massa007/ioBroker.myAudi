'use strict';

/* ======================================================================
 * Darts Turnierplaner – Frontend (Vanilla JS, Hash-Routing)
 * Alle dynamischen Inhalte laufen durch esc(); es gibt keine Inline-Styles
 * oder Inline-Skripte, damit eine strenge Content-Security-Policy greift.
 * ==================================================================== */

const $app = document.getElementById('app');
const state = {
  me: null,
  approved: true,
  needsSetup: false,
  registrationOpen: true,
  users: null,
  event: null,
  season: null,
  refreshTimer: null,
  editing: null,
  seasonFilter: 'points',
  playerSeason: {},
  statsSeason: '',
};

const STATUS_LABEL = {
  registration: 'Anmeldung offen',
  qualifying: 'Vorrunde',
  cups: 'Cups laufen',
  finished: 'Beendet',
};
const MODE_LABEL = { single: 'Einzel', double: 'Doppel' };
const CUP_NAMES = { pro: 'Pro Cup', advanced: 'Advanced Cup', beginner: 'Beginners Cup' };
const CATEGORY_LABEL = { winner: 'Sieger', final: 'Finalist', semi: 'Halbfinale', other: 'Ausgeschieden' };
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- utils

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtDate(d) {
  if (!d) return 'ohne Datum';
  const [y, m, day] = d.split('-');
  return day && m && y ? `${day}.${m}.${y}` : d;
}

function dateChip(d) {
  const [, m, day] = (d || '').split('-');
  if (!day) return `<div class="date-chip"><b>?</b><span>offen</span></div>`;
  return `<div class="date-chip"><b>${esc(Number(day))}</b><span>${esc(MONTHS[Number(m) - 1] || '')}</span></div>`;
}

function initials(name) {
  return esc(
    String(name || '?')
      .split(/[\s&]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('')
  );
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
const canPlay = () => !!state.me && state.approved;

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function cupTag(key) {
  return key ? `<span class="cup-tag cup-${esc(key)}">${esc(CUP_NAMES[key] || key)}</span>` : '<span class="muted">–</span>';
}

function statusBadge(status) {
  const live = status === 'qualifying' || status === 'cups';
  return `<span class="badge ${esc(status)}">${live ? '<i class="live-dot"></i>' : ''}${esc(STATUS_LABEL[status] || status)}</span>`;
}

async function loadUsers(force = false) {
  if (!state.me) return [];
  if (!state.users || force) state.users = await api('GET', '/api/users');
  return state.users;
}

// ---------------------------------------------------------------- dartscheibe (SVG)

function dartboardSVG() {
  const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const pt = (r, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  };
  const sector = (r1, r2, a1, a2) =>
    `M${pt(r2, a1)} A${r2} ${r2} 0 0 1 ${pt(r2, a2)} L${pt(r1, a2)} A${r1} ${r1} 0 0 0 ${pt(r1, a1)}Z`;
  let paths = '';
  order.forEach((n, i) => {
    const a1 = i * 18 - 9;
    const a2 = a1 + 18;
    const dark = i % 2 === 0;
    const single = dark ? '#16130f' : '#efe3c4';
    const ring = dark ? '#e0283f' : '#0f9d63';
    paths += `<path d="${sector(16, 99, a1, a2)}" fill="${single}"/>`;
    paths += `<path d="${sector(99, 107, a1, a2)}" fill="${ring}"/>`;
    paths += `<path d="${sector(107, 162, a1, a2)}" fill="${single}"/>`;
    paths += `<path d="${sector(162, 170, a1, a2)}" fill="${ring}"/>`;
    const [x, y] = pt(186, i * 18).split(' ');
    paths += `<text x="${x}" y="${y}" fill="#f3ead2" font-size="17" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="Space Grotesk, sans-serif">${n}</text>`;
  });
  const wires = order
    .map((_, i) => `<line x1="${pt(16, i * 18 - 9).replace(' ', '" y1="')}" x2="${pt(170, i * 18 - 9).replace(' ', '" y2="')}"/>`)
    .join('');
  return `<svg viewBox="-205 -205 410 410" aria-hidden="true">
    <circle r="204" fill="#0d0b09"/><circle r="200" fill="#1b1612"/>
    ${paths}
    <circle r="16" fill="#0f9d63"/><circle r="6.4" fill="#e0283f"/>
    <g stroke="#c9c2b0" stroke-opacity=".55" stroke-width=".8" fill="none">
      ${wires}<circle r="170"/><circle r="162"/><circle r="107"/><circle r="99"/><circle r="16"/><circle r="6.4"/>
    </g>
  </svg>`;
}

function dartSVG() {
  return `<svg viewBox="0 0 300 40" aria-hidden="true">
    <defs><linearGradient id="barrel" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f4f6fb"/><stop offset=".5" stop-color="#9aa3b5"/><stop offset="1" stop-color="#4b5263"/></linearGradient>
    <linearGradient id="flight" x1="0" x2="1"><stop offset="0" stop-color="#ff3b5c"/><stop offset="1" stop-color="#ff7a59"/></linearGradient></defs>
    <path d="M0 20 L34 17.5 L34 22.5Z" fill="#c9ced8"/>
    <rect x="34" y="13" width="92" height="14" rx="6" fill="url(#barrel)"/>
    <g stroke="#3b4150" stroke-width="1.2">${Array.from({ length: 9 }, (_, i) => `<line x1="${48 + i * 8}" y1="14" x2="${48 + i * 8}" y2="26"/>`).join('')}</g>
    <rect x="126" y="17" width="96" height="6" rx="3" fill="#20242e"/>
    <path d="M210 20 L268 1 L298 3 L254 20 L298 37 L268 39Z" fill="url(#flight)"/>
    <path d="M210 20 L298 20" stroke="#fff" stroke-opacity=".5"/>
  </svg>`;
}

// ---------------------------------------------------------------- chrome

function renderChrome() {
  const hash = location.hash || '#/';
  const links = [
    ['#/', 'Übersicht'],
    ['#/events', 'Termine'],
    ['#/seasons', 'Seasons'],
    ['#/stats', 'Statistiken'],
  ];
  if (state.me) links.push(['#/players', 'Spieler']);
  document.getElementById('nav').innerHTML = links
    .map(([h, l]) => {
      const active = h === '#/' ? hash === '#/' || hash === '' : hash.startsWith(h);
      return `<a href="${h}" class="${active ? 'active' : ''}">${l}</a>`;
    })
    .join('');
  document.getElementById('userbox').innerHTML = state.me
    ? `<a href="#/players/${esc(state.me.id)}" title="Meine Statistiken">${esc(state.me.name)} ${isAdmin() ? '<span class="badge admin">Admin</span>' : ''}</a>
       <a href="#/profile" title="Profil & Passwort" aria-label="Profil-Einstellungen">⚙</a>
       <a href="#" data-action="logout">Abmelden</a>`
    : `<a href="#/login">Anmelden</a>${state.registrationOpen || state.needsSetup ? '<a class="btn primary" href="#/register">Registrieren</a>' : ''}`;
  document.getElementById('topbar').classList.remove('open');
}

function pendingNotice() {
  if (state.me && !state.approved) {
    return `<div class="notice">⏳ <span>Dein Account wartet noch auf die Freischaltung durch einen Admin. Bis dahin kannst du dich nicht zu Terminen anmelden.</span></div>`;
  }
  return '';
}

// ---------------------------------------------------------------- startseite

async function viewHome() {
  const [events, seasons, stats] = await Promise.all([api('GET', '/api/events'), api('GET', '/api/seasons'), api('GET', '/api/stats')]);
  const active = seasons.find((s) => s.active);
  const standings = active ? await api('GET', `/api/seasons/${encodeURIComponent(active.id)}/standings`) : null;
  const upcoming = events.filter((e) => e.status !== 'finished').sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  const finished = events.filter((e) => e.status === 'finished').slice(0, 6);
  const live = upcoming.find((e) => e.status === 'qualifying' || e.status === 'cups');

  const cta = state.me
    ? `${upcoming[0] ? `<a class="btn primary lg" href="#/events/${esc(upcoming[0].id)}">${live ? 'Zum Live-Turnier' : 'Zum nächsten Termin'} →</a>` : ''}
       ${active ? `<a class="btn lg" href="#/seasons/${esc(active.id)}">Season-Tabelle</a>` : ''}`
    : `${state.registrationOpen || state.needsSetup ? '<a class="btn primary lg" href="#/register">Jetzt mitspielen →</a>' : ''}
       <a class="btn lg" href="#/events">Termine ansehen</a>`;

  return `
    ${state.needsSetup ? `<div class="notice info">🛠 <span><strong>Ersteinrichtung:</strong> Noch kein Admin vorhanden. Registriere dich mit dem <em>Setup-Code</em> aus dem Server-Log, um Administrator zu werden.</span> <a class="btn small" href="#/register">Einrichten</a></div>` : ''}
    ${pendingNotice()}
    <section class="hero">
      <div>
        <span class="eyebrow reveal">${live ? '<i class="live-dot cup-advanced"></i> Live: ' + esc(live.name) : '🎯 ' + esc(active ? active.name : 'Darts Liga')}</span>
        <h1 class="reveal" data-i="1">Jeder Pfeil <span class="gradient-text">zählt.</span></h1>
        <p class="lead reveal" data-i="2">Einzel und Doppel, Vorrunde mit fünf Spielen, danach Pro-, Advanced- und Beginners-Cup im Doppel-K.o. – und jeder Abend bringt Punkte für die Season.</p>
        <div class="row reveal" data-i="3">${cta}</div>
        <div class="stats reveal" data-i="4">
          <div class="stat"><b data-count="${Number(stats.players) || 0}">0</b><span>Spieler</span></div>
          <div class="stat"><b data-count="${Number(stats.matches) || 0}">0</b><span>Spiele</span></div>
          <div class="stat"><b data-count="${Number(stats.legs) || 0}">0</b><span>Legs</span></div>
        </div>
      </div>
      <div class="board-stage" id="board-stage">
        <div class="orbit"></div>
        <div class="board-3d" id="board">
          <div class="board-shadow"></div>
          ${Array.from({ length: 6 }, (_, i) => `<div class="layer rim" data-z="${i * 3}"></div>`).join('')}
          <div class="layer face">${dartboardSVG()}</div>
          <div class="layer shine"></div>
          <div class="dart">${dartSVG()}</div>
        </div>
      </div>
    </section>

    <div class="section-head"><div><span class="eyebrow reveal">Kalender</span><h2 class="reveal">Nächste Termine</h2></div><a class="reveal" href="#/events">Alle Termine →</a></div>
    ${
      upcoming.length
        ? `<div class="grid">${upcoming.slice(0, 6).map((e, i) => eventCard(e, i)).join('')}</div>`
        : `<div class="card empty reveal"><div class="big">📅</div>Aktuell sind keine Termine geplant.</div>`
    }

    ${
      active
        ? `<div class="section-head"><div><span class="eyebrow reveal">${esc(active.name)}</span><h2 class="reveal">Season-Ranking</h2></div><a class="reveal" href="#/seasons/${esc(active.id)}">Komplette Tabelle →</a></div>
           ${standings && standings.rows.length ? rankingBlock(standings.rows, 8) : `<div class="card empty reveal"><div class="big">🏆</div>Sobald der erste Termin abgeschlossen ist, erscheint hier das Ranking.</div>`}`
        : ''
    }

    <div class="section-head"><div><span class="eyebrow reveal">Turniermodus</span><h2 class="reveal">So läuft ein Dartsabend</h2></div></div>
    <div class="howto">
      <div class="card tilt reveal-flip" data-i="0"><div class="num lift">01</div><h3>Vorrunde</h3><p>Jeder spielt 5 Partien gegen zufällig geloste Gegner. Siege und Leg-Differenz entscheiden über die Tabelle.</p></div>
      <div class="card tilt reveal-flip" data-i="1"><div class="num lift">02</div><h3>Drei Cups</h3><p>Das obere Drittel spielt im Pro Cup, die Mitte im Advanced Cup, der Rest im Beginners Cup.</p>
        <div class="cup-pills"><span class="badge cup-pro">Pro</span><span class="badge cup-advanced">Advanced</span><span class="badge cup-beginner">Beginners</span></div></div>
      <div class="card tilt reveal-flip" data-i="2"><div class="num lift">03</div><h3>Zweite Chance</h3><p>Wer einmal verliert, rutscht ins Losers Bracket und kann sich von dort noch ins Halbfinale kämpfen.</p></div>
      <div class="card tilt reveal-flip" data-i="3"><div class="num lift">04</div><h3>K.o.-Finals</h3><p>Ab dem Halbfinale zählt nur noch der Sieg. Platzierungen bringen Punkte für die Season-Wertung.</p></div>
    </div>

    ${
      finished.length
        ? `<div class="section-head"><div><span class="eyebrow reveal">Hall of Fame</span><h2 class="reveal">Letzte Sieger</h2></div></div>
           <div class="grid">${finished.map((e, i) => eventCard(e, i)).join('')}</div>`
        : ''
    }`;
}

function rankingBlock(rows, limit) {
  const top = rows.slice(0, 3);
  const maxPts = Math.max(1, ...rows.map((r) => r.points));
  const order = [top[1], top[0], top[2]];
  const cls = ['p2', 'p1', 'p3'];
  return `<div class="grid-2">
    <div class="card reveal">
      <div class="podium reveal-rise">${order
        .map((r, i) =>
          r
            ? `<div class="place ${cls[i]}"><div class="who">${esc(r.name)}<small>${esc(r.points)} Punkte</small></div><div class="block">${cls[i].slice(1)}</div></div>`
            : `<div class="place ${cls[i]}"></div>`
        )
        .join('')}</div>
    </div>
    <div class="card reveal" data-i="1"><div class="table-wrap"><table><tbody>${rows
      .slice(0, limit)
      .map(
        (r) => `<tr class="${r.userId === state.me?.id ? 'me' : ''}"><td class="rank medal">${esc(r.rank)}</td><td>${playerLink(r.userId, r.name)}</td>
          <td class="bar-cell"><div class="bar"><i data-w="${Math.round((r.points / maxPts) * 100)}"></i></div></td><td class="num"><strong>${esc(r.points)}</strong></td></tr>`
      )
      .join('')}</tbody></table></div></div>
  </div>`;
}

function eventCard(e, i = 0) {
  const unit = e.mode === 'double' ? 'Teams' : 'Spieler';
  return `<a class="card event-card tilt reveal" data-i="${i % 6}" href="#/events/${esc(e.id)}">
    <div class="spread lift">${dateChip(e.date)}${statusBadge(e.status)}</div>
    <h3 class="lift">${esc(e.name)}</h3>
    <div class="meta-line"><span>${esc(MODE_LABEL[e.mode])}</span><span>${esc(e.entryCount)}${e.maxEntries ? ' / ' + esc(e.maxEntries) : ''} ${unit}</span>${e.location ? `<span>📍 ${esc(e.location)}</span>` : ''}</div>
    ${e.winners.length ? `<div class="winners small">${e.winners.map((w) => `<div>🏆 <strong>${esc(w.name)}</strong> <span class="muted">${esc(w.cup)}</span></div>`).join('')}</div>` : ''}
  </a>`;
}

// ---------------------------------------------------------------- termine

async function viewEvents() {
  const [events, seasons] = await Promise.all([api('GET', '/api/events'), api('GET', '/api/seasons')]);
  return `
    <div class="page-head"><span class="eyebrow reveal">Kalender</span><h1 class="reveal">Termine</h1></div>
    ${pendingNotice()}
    ${isAdmin() ? `<details class="card reveal"><summary>Neuen Termin anlegen</summary><div>${eventForm(null, seasons)}</div></details>` : ''}
    ${events.length ? `<div class="grid">${events.map((e, i) => eventCard(e, i)).join('')}</div>` : '<div class="card empty"><div class="big">📅</div>Noch keine Termine angelegt.</div>'}`;
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
      .map((s) => `<option value="${esc(s.id)}" ${s.id === v.seasonId ? 'selected' : ''}>${esc(s.name)}</option>`)
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

// ---------------------------------------------------------------- termin-details

const TABS = [
  ['entries', 'Teilnehmer'],
  ['qualifying', 'Vorrunde'],
  ['cups', 'Cups'],
  ['results', 'Ergebnis & Punkte'],
  ['stats', 'Statistik'],
];

function defaultTab(ev) {
  return { registration: 'entries', qualifying: 'qualifying', cups: 'cups', finished: 'results' }[ev.status];
}

async function viewEvent(id, tab) {
  const ev = await api('GET', `/api/events/${encodeURIComponent(id)}`);
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
  else if (tab === 'stats') body = await tabStats(ev);
  else if (tab === 'settings' && isAdmin()) body = `<div class="card">${eventForm(ev, await api('GET', '/api/seasons'))}</div>${adminResetBox(ev)}`;

  return `
    <div class="page-head">
      <div class="spread"><span class="eyebrow">${esc(MODE_LABEL[ev.mode])}${ev.seasonName ? ` · <a href="#/seasons/${esc(ev.seasonId)}">${esc(ev.seasonName)}</a>` : ''}</span>${statusBadge(ev.status)}</div>
      <h1>${esc(ev.name)}</h1>
      <div class="meta-line"><span>📅 ${esc(fmtDate(ev.date))}</span>${ev.location ? `<span>📍 ${esc(ev.location)}</span>` : ''}<span>👥 ${esc(ev.entries.length)}${ev.maxEntries ? ' / ' + esc(ev.maxEntries) : ''} ${ev.mode === 'double' ? 'Teams' : 'Spieler'}</span></div>
      ${ev.notes ? `<p class="muted">${esc(ev.notes)}</p>` : ''}
    </div>
    <div class="steps" data-step="${cur}">${steps.map((s, i) => `<span class="${i < cur || ev.status === 'finished' ? 'done' : i === cur ? 'current' : ''}">${STATUS_LABEL[s]}</span>`).join('')}</div>
    <nav class="tabs">${TABS.filter(([k]) => k !== 'stats' || ev.status !== 'registration').map(([k, l]) => `<a href="#/events/${esc(ev.id)}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}
      ${isAdmin() ? `<a href="#/events/${esc(ev.id)}/settings" class="${tab === 'settings' ? 'active' : ''}">⚙ Einstellungen</a>` : ''}</nav>
    ${pendingNotice()}
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
  const free = users.filter((u) => !registered.has(u.id) && u.approved);
  const open = ev.status === 'registration';
  const full = ev.maxEntries && ev.entries.length >= ev.maxEntries;
  const solos = ev.entries.filter((e) => !e.complete);
  const opt = (u) => `<option value="${esc(u.id)}">${esc(u.name)}${u.guest ? ' (Gast)' : ''}</option>`;

  let myBox = '';
  if (open && state.me && state.approved) {
    if (ev.myEntryId) {
      const mine = ev.entries.find((e) => e.id === ev.myEntryId);
      myBox = `<div class="card reveal"><div class="spread"><div>✅ Du bist angemeldet${ev.mode === 'double' ? ` als <strong>${esc(mine.name)}</strong>${mine.complete ? '' : ' – <em>Partner gesucht</em>'}` : ''}.</div>
        <button class="danger" data-action="entry-remove" data-entry="${esc(mine.id)}">Abmelden</button></div>
        ${ev.mode === 'double' && mine.complete ? `<form data-form="team-name" data-entry="${esc(mine.id)}" class="row mt"><input class="narrow" name="teamName" maxlength="60" placeholder="Teamname (optional)" value="${esc(mine.teamName)}"><button>Speichern</button></form>` : ''}</div>`;
    } else if (full) {
      myBox = `<div class="notice">Dieser Termin ist ausgebucht.</div>`;
    } else if (ev.mode === 'single') {
      myBox = `<div class="card reveal"><div class="spread"><div><h3>Bist du dabei?</h3><span class="muted">Melde dich mit einem Klick an.</span></div><button class="primary" data-action="register-self">Jetzt anmelden</button></div></div>`;
    } else {
      myBox = `<div class="card reveal"><h3>Für das Doppel anmelden</h3>
        <form data-form="register-double" class="form-grid">
          <div><label>Partner</label><select name="partnerId"><option value="">– Partner gesucht –</option>${free.filter((u) => u.id !== state.me.id).map(opt).join('')}</select></div>
          <div><label>Teamname (optional)</label><input name="teamName" maxlength="60"></div>
          <div class="end"><button class="primary">Anmelden</button></div>
        </form>
        ${solos.length ? `<p class="small muted mt">Oder einem Spieler ohne Partner beitreten:</p><div class="row">${solos.map((s) => `<button class="small" data-action="join-entry" data-entry="${esc(s.id)}">Mit ${esc(s.name)} spielen</button>`).join('')}</div>` : ''}
      </div>`;
    }
  } else if (open && !state.me) {
    myBox = `<div class="notice info">🎯 <span><a href="#/login">Melde dich an</a> oder <a href="#/register">registriere dich</a>, um teilzunehmen.</span></div>`;
  }

  const adminBox =
    isAdmin() && open
      ? `<details class="card reveal" open><summary>Admin: Teilnehmer verwalten</summary><div>
        <form data-form="admin-add-entry" class="form-grid">
          <div><label>Spieler${ev.mode === 'double' ? ' 1' : ''}</label><select name="p1" required><option value="">– wählen –</option>${free.map(opt).join('')}</select></div>
          ${ev.mode === 'double' ? `<div><label>Spieler 2 (optional)</label><select name="p2"><option value="">– Partner gesucht –</option>${free.map(opt).join('')}</select></div>` : ''}
          <div class="end"><button>Eintragen</button></div>
        </form>
        <form data-form="guest-add" class="row mt">
          <input class="narrow" name="name" placeholder="Neuer Gastspieler (ohne Account)" maxlength="60" required>
          <label class="checkbox"><input type="checkbox" name="register" checked> direkt eintragen</label>
          <button>Gast anlegen</button>
        </form>
        <div class="row mt-lg">
          ${ev.mode === 'double' && solos.length > 1 ? `<button data-action="pair-solos">🎲 Einzelspieler zu Teams auslosen (${solos.length})</button>` : ''}
          <button class="primary" data-action="start-qualifying" ${ev.entries.length < 2 || solos.length ? 'disabled' : ''}>▶ Vorrunde starten (${esc(ev.qualiRounds)} Spiele je ${ev.mode === 'double' ? 'Team' : 'Spieler'})</button>
        </div>
        ${solos.length ? `<p class="small muted">Vor dem Start müssen alle Teams vollständig sein.</p>` : ''}
      </div></details>`
      : '';

  return `${myBox}${adminBox}
    <div class="section-head"><h2>${esc(ev.entries.length)}${ev.maxEntries ? ' / ' + esc(ev.maxEntries) : ''} ${unit}</h2></div>
    ${
      ev.entries.length
        ? `<ul class="entry-list">${ev.entries
            .map(
              (e, i) => `<li class="reveal" data-i="${i % 8}"><span class="who"><span class="avatar">${initials(e.name)}</span><span><strong>${e.players.length === 1 ? playerLink(e.players[0].id, e.name) : esc(e.name)}</strong>
                ${ev.mode === 'double' ? `<br><span class="muted small">${e.players.map((p) => playerLink(p.id, p.name)).join(' & ')}</span>` : ''}</span></span>
                ${!e.complete ? '<span class="badge warn">Partner gesucht</span>' : ''}
                ${isAdmin() && open && e.id !== ev.myEntryId ? `<button class="small danger" data-action="entry-remove" data-entry="${esc(e.id)}" aria-label="Entfernen">✕</button>` : ''}</li>`
            )
            .join('')}</ul>`
        : '<div class="card empty"><div class="big">🎯</div>Noch keine Anmeldungen – sei der Erste!</div>'
    }`;
}

function matchCard(ev, m, names, opts = {}) {
  const nameA = names[m.a] || '?';
  const nameB = m.bye ? 'Freilos' : names[m.b] || '?';
  const done = !!m.winner;
  const mine = isMyEntry(ev, m.a) || isMyEntry(ev, m.b);
  const canEdit = m.editable && canPlay() && (isAdmin() || mine);
  const sideCls = (id) => (!done ? '' : m.winner === id ? 'win' : 'lose');
  const stageLabel = { Q: `Runde ${m.round}`, W: 'Winners', L: 'Losers', SF: 'Halbfinale', F: 'Finale' }[m.stage];
  const max = Math.ceil(m.bestOf / 2);
  const form =
    canEdit && (!done || state.editing === m.id)
      ? `<form class="result-form" data-form="result" data-match="${esc(m.id)}">
          <input type="number" name="legsA" min="0" max="${max}" value="${done ? esc(m.legsA) : ''}" aria-label="Legs ${esc(nameA)}" required>
          <span>:</span>
          <input type="number" name="legsB" min="0" max="${max}" value="${done ? esc(m.legsB) : ''}" aria-label="Legs ${esc(nameB)}" required>
          <button class="small primary" aria-label="Ergebnis speichern">✓</button>
        </form>`
      : '';
  return `<div class="match ${done ? 'done' : 'open'} ${m.bye ? 'bye' : ''} ${mine ? 'mine' : ''}">
    <div class="meta"><span>${esc(opts.label || stageLabel)}${m.bye ? '' : ` · Bo${esc(m.bestOf)}`}</span>
      ${canEdit && done && state.editing !== m.id ? `<button class="small ghost" data-action="edit-result" data-match="${esc(m.id)}">Ändern</button>` : ''}</div>
    <div class="side ${sideCls(m.a)}"><span>${esc(nameA)}</span><span class="legs">${done && !m.bye ? esc(m.legsA) : ''}</span></div>
    <div class="side ${m.bye ? '' : sideCls(m.b)}"><span>${esc(nameB)}</span><span class="legs">${done && !m.bye ? esc(m.legsB) : ''}</span></div>
    ${form}
  </div>`;
}

function previewCupSizes(n, k) {
  k = Math.max(1, Math.min(k, 3, Math.max(1, Math.floor(n / 2))));
  const base = Math.floor(n / k);
  const rem = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

function tabQualifying(ev, names) {
  if (!ev.qualifying) return `<div class="card empty"><div class="big">⏳</div>Die Vorrunde wurde noch nicht gestartet.</div>`;
  const q = ev.qualifying;
  const rounds = [...new Set(q.matches.map((m) => m.round))].sort((a, b) => a - b);
  const openCount = q.matches.filter((m) => !m.winner).length;
  const preview = previewCupSizes(ev.entries.length, ev.numCups || ev.defaultCupCount);
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
      ? `<div class="card reveal"><div class="spread"><div><h3>Cups auslosen</h3><span class="small muted">Oberes Drittel → Pro, mittleres → Advanced, unteres → Beginners.</span></div>
        <form data-form="start-cups" class="row">
          <label class="checkbox">Cups
            <select name="numCups" class="auto">${[1, 2, 3]
              .filter((k) => k <= ev.maxCupCount)
              .map((k) => `<option value="${k}" ${k === ev.defaultCupCount ? 'selected' : ''}>${k}</option>`)
              .join('')}</select></label>
          <button class="primary" ${openCount ? 'disabled' : ''}>▶ Cups starten</button>
        </form></div>
        ${openCount ? `<p class="small muted">Noch ${esc(openCount)} offene Spiele in der Vorrunde.</p>` : ''}</div>`
      : '';

  return `${adminBox}
    <div class="card reveal"><h2>Tabelle der Vorrunde</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>${ev.mode === 'double' ? 'Team' : 'Spieler'}</th><th class="num">Sp.</th><th class="num">S</th><th class="num">N</th><th class="num">Legs</th><th class="num">Diff</th><th>${ev.cups.length ? 'Cup' : 'Prognose'}</th></tr></thead>
        <tbody>${q.standings
          .map((r) => {
            const cupKey = ev.cups.length ? ev.cups.find((c) => c.entryIds.includes(r.entryId))?.key : cupOf(r.rank);
            return `<tr class="${isMyEntry(ev, r.entryId) ? 'me' : ''} ${cuts.has(r.rank) ? 'cut' : ''}">
              <td class="rank">${esc(r.rank)}</td><td>${esc(names[r.entryId])}</td>
              <td class="num">${esc(r.played + r.byes)}</td><td class="num">${esc(r.wins)}</td><td class="num">${esc(r.losses)}</td>
              <td class="num">${esc(r.legsFor)}:${esc(r.legsAgainst)}</td><td class="num">${r.legDiff > 0 ? '+' : ''}${esc(r.legDiff)}</td>
              <td>${cupTag(cupKey)}</td></tr>`;
          })
          .join('')}</tbody></table></div>
      <p class="small muted">Sortierung: Siege, Leg-Differenz, gewonnene Legs, Los. Freilose zählen als Sieg.</p>
    </div>
    ${rounds
      .map(
        (r) => `<div class="bracket-section reveal"><h3>Runde ${esc(r)}</h3><div class="matches">${q.matches
          .filter((m) => m.round === r)
          .map((m) => matchCard(ev, m, names))
          .join('')}</div></div>`
      )
      .join('')}`;
}

function stageName(m) {
  return { W: 'Winners Bracket', L: 'Losers Bracket', SF: 'Halbfinale', F: 'Finale' }[m.stage];
}

function tabCups(ev, names) {
  if (!ev.cups.length) return `<div class="card empty"><div class="big">🏆</div>Die Cups werden nach der Vorrunde ausgelost.</div>`;
  const open = ev.cups.flatMap((c) => c.matches.filter((m) => !m.winner).map((m) => ({ m, c })));
  return `
    ${open.length ? `<div class="card reveal"><h2><i class="live-dot cup-advanced"></i> Jetzt zu spielen (${esc(open.length)})</h2><div class="matches">${open.map(({ m, c }) => matchCard(ev, m, names, { label: `${CUP_NAMES[c.key]} · ${stageName(m)}` })).join('')}</div></div>` : ''}
    ${ev.cups.map((c) => cupBlock(ev, c, names)).join('')}`;
}

function cupBlock(ev, cup, names) {
  const rounds = (stage) => [...new Set(cup.matches.filter((m) => m.stage === stage).map((m) => m.round))].sort((a, b) => a - b);
  const columns = (stage) =>
    rounds(stage)
      .map(
        (r, i) => `<div class="col"><div class="col-title">Runde ${i + 1}</div>${cup.matches
          .filter((m) => m.stage === stage && m.round === r)
          .map((m) => matchCard(ev, m, names))
          .join('')}</div>`
      )
      .join('');
  const finals = ['SF', 'F']
    .map((s) => {
      const ms = cup.matches.filter((m) => m.stage === s);
      return ms.length ? `<div class="col"><div class="col-title">${s === 'SF' ? 'Halbfinale' : 'Finale'}</div>${ms.map((m) => matchCard(ev, m, names)).join('')}</div>` : '';
    })
    .join('');
  const champ = cup.placements?.find((p) => p.place === 1);
  const lb = columns('L');

  return `<section class="card reveal">
    <div class="spread cup-header cup-${esc(cup.key)}">
      <div><h2 class="cup-${esc(cup.key)}">${esc(cup.name)}</h2><div class="muted small">${esc(cup.entryIds.length)} ${ev.mode === 'double' ? 'Teams' : 'Spieler'} · Setzliste nach Vorrunde</div></div>
      <div class="row">${champ ? `<span class="champion">🏆 ${esc(names[champ.entryId])}</span>` : ''}
        ${isAdmin() && cup.canUndo ? `<button class="small" data-action="undo-round" data-cup="${esc(cup.key)}" title="Löscht die zuletzt ausgeloste Runde, um Ergebnisse der Runde davor zu korrigieren">↶ Letzte Runde zurücknehmen</button>` : ''}</div>
    </div>
    <div class="bracket-section mt-lg"><h3>Winners Bracket</h3><div class="bracket">${columns('W') || '<p class="muted small">–</p>'}</div></div>
    <div class="bracket-section"><h3>Losers Bracket</h3><div class="bracket">${lb || '<p class="muted small">Noch keine Spiele – wer im Winners Bracket verliert, landet hier.</p>'}</div></div>
    ${finals ? `<div class="bracket-section"><h3>Finalrunde (K.o.)</h3><div class="bracket">${finals}</div></div>` : ''}
  </section>`;
}

function tabResults(ev, names) {
  if (!ev.points) return `<div class="card empty"><div class="big">📊</div>Ergebnisse gibt es nach dem Start der Vorrunde.</div>`;
  const podiums = ev.cups
    .filter((c) => c.placements)
    .map((c, i) => {
      const at = (p) => c.placements.filter((x) => x.place === p);
      const p1 = at(1)[0];
      const p2 = at(2)[0];
      const p3 = at(3);
      const place = (cls, list, label) =>
        `<div class="place ${cls}"><div class="who">${list.length ? list.map((p) => esc(names[p.entryId])).join(' / ') : '–'}<small>${label}</small></div><div class="block">${cls.slice(1)}</div></div>`;
      return `<div class="card reveal" data-i="${i}"><h2 class="cup-${esc(c.key)}">${esc(c.name)}</h2>
        <div class="podium reveal-rise">${place('p2', p2 ? [p2] : [], 'Finalist')}${place('p1', p1 ? [p1] : [], 'Sieger')}${place('p3', p3, 'Halbfinale')}</div></div>`;
    })
    .join('');
  const rows = [...ev.points].sort((a, b) => b.points - a.points || (a.place ?? 99) - (b.place ?? 99));
  const maxPts = Math.max(1, ...rows.map((r) => r.points));
  return `${podiums ? `<div class="grid">${podiums}</div>` : ''}
    <div class="card reveal"><h2>Punkte dieses Termins</h2>
      ${ev.status !== 'finished' ? '<p class="small muted">Vorläufig – fließt erst nach Abschluss aller Cups in die Season-Wertung ein.</p>' : ''}
      ${!ev.seasonId ? '<p class="small muted">Dieser Termin gehört zu keiner Season.</p>' : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>${ev.mode === 'double' ? 'Team' : 'Spieler'}</th><th>Cup</th><th class="num">Platz</th><th class="num">VR-Siege</th><th></th><th class="num">Punkte${ev.mode === 'double' ? ' je Spieler' : ''}</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr class="${isMyEntry(ev, r.entryId) ? 'me' : ''}"><td>${esc(names[r.entryId])}</td><td>${cupTag(r.cup)}</td>
              <td class="num">${r.place ? esc(r.place) + '.' : '–'}</td><td class="num">${esc(r.qualiWins)}</td>
              <td class="bar-cell"><div class="bar"><i data-w="${Math.round((r.points / maxPts) * 100)}"></i></div></td>
              <td class="num"><strong>${esc(r.points)}</strong></td></tr>`
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
      if (!busy && !typed && !state.editing && !document.hidden && location.hash.startsWith(`#/events/${ev.id}`)) route(true);
    }, 15000);
  }
}

// ---------------------------------------------------------------- seasons

function seasonRange(s) {
  if (!s.startDate && !s.endDate) return '';
  return `${s.startDate ? fmtDate(s.startDate) : '…'} – ${s.endDate ? fmtDate(s.endDate) : '…'}`;
}

async function viewSeasons() {
  const seasons = await api('GET', '/api/seasons');
  return `<div class="page-head"><span class="eyebrow reveal">Wertung</span><h1 class="reveal">Seasons</h1></div>
    ${isAdmin() ? `<details class="card reveal"><summary>Neue Season anlegen</summary><div>${seasonForm(null)}</div></details>` : ''}
    ${
      seasons.length
        ? `<div class="grid">${seasons
            .map(
              (s, i) => `<a class="card event-card tilt reveal" data-i="${i % 6}" href="#/seasons/${esc(s.id)}"><div class="spread lift"><span class="eyebrow">🏆 Season</span>${s.active ? '<span class="badge registration"><i class="live-dot"></i>aktiv</span>' : ''}</div>
              <h3 class="lift">${esc(s.name)}</h3><div class="meta-line">${seasonRange(s) ? `<span>${esc(seasonRange(s))}</span>` : ''}<span>${esc(s.eventCount)} Termine</span></div></a>`
            )
            .join('')}</div>`
        : '<div class="card empty"><div class="big">🏆</div>Noch keine Seasons.</div>'
    }`;
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
      <div class="end"><label class="checkbox"><input type="checkbox" name="active" ${!s || s.active ? 'checked' : ''}> Aktive Season</label></div>
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
  const data = await api('GET', `/api/seasons/${encodeURIComponent(id)}/standings`);
  const s = data.season;
  state.season = s;
  const filter = state.seasonFilter;
  const rows = [...data.rows].sort((a, b) => b[filter] - a[filter] || b.points - a.points).filter((r) => filter === 'points' || r[filter] > 0);
  let rank = 0;
  let last = null;
  rows.forEach((r, i) => {
    if (r[filter] !== last) rank = i + 1;
    r.rank = rank;
    r.value = r[filter];
    last = r[filter];
  });
  const maxPts = Math.max(1, ...rows.map((r) => r.value));
  const p = s.points;
  return `<div class="page-head"><span class="eyebrow reveal">${s.active ? '<i class="live-dot cup-beginner"></i> Aktive Season' : 'Season'}${seasonRange(s) ? ' · ' + esc(seasonRange(s)) : ''}</span><h1 class="reveal">${esc(s.name)}</h1></div>
    <div class="row reveal">
      ${[['points', 'Gesamt'], ['single', 'Einzel'], ['double', 'Doppel']]
        .map(([k, l]) => `<button class="small ${filter === k ? 'primary' : ''}" data-action="season-filter" data-filter="${k}">${l}</button>`)
        .join('')}
    </div>
    ${
      rows.length
        ? `<div class="mt">${rankingPodium(rows)}</div>
        <div class="card flush reveal"><div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Spieler</th><th></th><th class="num">Punkte</th><th class="num">Einzel</th><th class="num">Doppel</th><th class="num">Termine</th><th class="num">Titel</th><th class="num">Finals</th><th class="num">VR-Siege</th>
          ${data.events.map((e) => `<th class="num" title="${esc(e.name)}"><a href="#/events/${esc(e.id)}">${esc(fmtDate(e.date).slice(0, 6) || e.name)}</a><br><span class="small">${e.mode === 'double' ? 'D' : 'E'}</span></th>`).join('')}</tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr class="${r.userId === state.me?.id ? 'me' : ''}"><td class="rank medal">${esc(r.rank)}</td><td><strong>${playerLink(r.userId, r.name)}</strong></td>
              <td class="bar-cell"><div class="bar"><i data-w="${Math.round((r.value / maxPts) * 100)}"></i></div></td>
              <td class="num"><strong>${esc(r.points)}</strong></td><td class="num">${esc(r.single)}</td><td class="num">${esc(r.double)}</td><td class="num">${esc(r.events)}</td>
              <td class="num">${esc(r.titles)}</td><td class="num">${esc(r.finals)}</td><td class="num">${esc(r.qualiWins)}</td>
              ${data.events
                .map((e) => {
                  const pe = r.perEvent[e.id];
                  return `<td class="num" title="${pe ? esc(`${CUP_NAMES[pe.cup] || ''} Platz ${pe.place ?? '–'}`) : ''}">${pe ? `<span class="cup-${esc(pe.cup)}">${esc(pe.points)}</span>` : '<span class="muted">–</span>'}</td>`;
                })
                .join('')}</tr>`
            )
            .join('')}</tbody></table></div></div>`
        : '<div class="card empty mt"><div class="big">🏆</div>Noch keine abgeschlossenen Termine in dieser Wertung.</div>'
    }
    <div class="card reveal mt-lg"><h2>Punktevergabe</h2>
      <p class="muted">Teilnahme: <strong>${esc(p.participation)}</strong> · je Vorrunden-Sieg: <strong>${esc(p.qualiWin)}</strong> (Freilose ausgenommen). Im Doppel erhalten beide Spieler die Punkte.</p>
      <div class="table-wrap"><table><thead><tr><th>Cup</th><th class="num">Sieger</th><th class="num">Finalist</th><th class="num">Halbfinale</th><th class="num">Sonstige</th></tr></thead>
      <tbody>${['pro', 'advanced', 'beginner'].map((k) => `<tr><td>${cupTag(k)}</td>${['winner', 'final', 'semi', 'other'].map((c) => `<td class="num">${esc(p.cups[k][c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    </div>
    ${isAdmin() ? `<details class="card"><summary>Season bearbeiten</summary><div>${seasonForm(s)}</div></details>` : ''}`;
}

function rankingPodium(rows) {
  const top = rows.slice(0, 3);
  const order = [top[1], top[0], top[2]];
  const cls = ['p2', 'p1', 'p3'];
  return `<div class="card reveal"><div class="podium reveal-rise">${order
    .map((r, i) =>
      r ? `<div class="place ${cls[i]}"><div class="who">${esc(r.name)}<small>${esc(r.value)} Punkte</small></div><div class="block">${cls[i].slice(1)}</div></div>` : `<div class="place ${cls[i]}"></div>`
    )
    .join('')}</div></div>`;
}

// ---------------------------------------------------------------- spieler & verwaltung

async function viewPlayers() {
  if (!state.me) return viewLogin();
  const users = await loadUsers(true);
  const settings = isAdmin() ? await api('GET', '/api/settings') : null;
  const pending = users.filter((u) => !u.approved);
  const list = users.filter((u) => u.approved);

  const settingsBox = settings
    ? `<div class="card reveal"><h2>Registrierung</h2>
      <form data-form="settings" class="stack">
        <label class="checkbox"><input type="checkbox" name="registrationOpen" ${settings.registrationOpen ? 'checked' : ''}> Neue Registrierungen erlauben</label>
        <label class="checkbox"><input type="checkbox" name="requireApproval" ${settings.requireApproval ? 'checked' : ''}> Neue Accounts müssen vom Admin freigeschaltet werden</label>
        <div><button class="primary">Speichern</button></div>
      </form></div>`
    : '';

  const pendingBox =
    isAdmin() && pending.length
      ? `<div class="card reveal"><h2>⏳ Warten auf Freischaltung (${esc(pending.length)})</h2>
        <ul class="entry-list">${pending
          .map(
            (u) => `<li><span class="who"><span class="avatar">${initials(u.name)}</span><span><strong>${esc(u.name)}</strong><br><span class="muted small">@${esc(u.username)}</span></span></span>
            <span class="row"><button class="small primary" data-action="user-approve" data-user="${esc(u.id)}">Freischalten</button><button class="small danger" data-action="user-delete" data-user="${esc(u.id)}">Ablehnen</button></span></li>`
          )
          .join('')}</ul></div>`
      : '';

  return `<div class="page-head"><span class="eyebrow reveal">Community</span><h1 class="reveal">Spieler</h1></div>
    ${pendingNotice()}
    ${pendingBox}
    ${
      isAdmin()
        ? `<div class="grid-2">${settingsBox}<div class="card reveal" data-i="1"><h2>Gastspieler</h2><form data-form="guest-add" class="row"><input class="narrow" name="name" placeholder="Name des Gastspielers" maxlength="60" required><button>Anlegen</button></form>
      <p class="small muted">Gastspieler haben keinen Login und werden vom Admin zu Terminen eingetragen.</p></div></div>`
        : ''
    }
    <div class="card flush reveal"><div class="table-wrap"><table>
      <thead><tr><th>Name</th>${isAdmin() ? '<th>Benutzername</th>' : ''}<th>Rolle</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${list
        .map(
          (u) => `<tr class="${u.id === state.me.id ? 'me' : ''}"><td><strong>${playerLink(u.id, u.name)}</strong></td>${isAdmin() ? `<td class="muted">${u.username ? '@' + esc(u.username) : '–'}</td>` : ''}
          <td>${u.role === 'admin' ? '<span class="badge admin">Admin</span>' : u.guest ? '<span class="badge">Gast</span>' : '<span class="badge">Spieler</span>'}</td>
          ${
            isAdmin()
              ? `<td class="right"><span class="row">
                <button class="small" data-action="user-rename" data-user="${esc(u.id)}">Umbenennen</button>
                ${!u.guest ? `<button class="small" data-action="user-password" data-user="${esc(u.id)}">Passwort</button>` : ''}
                ${!u.guest && u.id !== state.me.id ? `<button class="small" data-action="user-role" data-user="${esc(u.id)}" data-role="${u.role === 'admin' ? 'player' : 'admin'}">${u.role === 'admin' ? 'Admin entziehen' : 'Zum Admin'}</button>` : ''}
                ${u.role !== 'admin' ? `<button class="small danger" data-action="user-delete" data-user="${esc(u.id)}" aria-label="Löschen">✕</button>` : ''}
              </span></td>`
              : ''
          }</tr>`
        )
        .join('')}</tbody></table></div></div>`;
}

function viewLogin() {
  return `<div class="auth-wrap"><div class="card auth-box tilt reveal"><span class="eyebrow">Willkommen zurück</span><h1>Anmelden</h1>
    <form data-form="login" class="stack">
      <div><label>Benutzername</label><input name="username" autocomplete="username" required></div>
      <div><label>Passwort</label><input type="password" name="password" autocomplete="current-password" required></div>
      <button class="primary">Anmelden</button>
      ${state.registrationOpen ? '<p class="small muted">Noch kein Account? <a href="#/register">Registrieren</a></p>' : ''}
    </form></div></div>`;
}

function viewRegister() {
  if (!state.registrationOpen && !state.needsSetup) {
    return `<div class="auth-wrap"><div class="card auth-box empty"><div class="big">🔒</div>Die Registrierung ist derzeit geschlossen. Wende dich an den Turnierleiter.</div></div>`;
  }
  return `<div class="auth-wrap"><div class="card auth-box tilt reveal"><span class="eyebrow">Mitspielen</span><h1>Registrieren</h1>
    ${state.needsSetup ? '<div class="notice info small">Ersteinrichtung: Mit dem Setup-Code aus dem Server-Log wirst du Administrator.</div>' : ''}
    ${!state.needsSetup && state.requireApproval ? '<p class="small muted">Neue Accounts werden von einem Admin freigeschaltet.</p>' : ''}
    <form data-form="register" class="stack">
      ${state.needsSetup ? '<div><label>Setup-Code</label><input name="setupCode" required autocomplete="off"></div>' : ''}
      <div><label>Anzeigename</label><input name="name" maxlength="60" required placeholder="z. B. Max Mustermann"></div>
      <div><label>Benutzername</label><input name="username" autocomplete="username" required pattern="[a-zA-Z0-9_.\\-]{3,40}" title="3–40 Zeichen: Buchstaben, Zahlen, _ . -"></div>
      <div><label>Passwort (min. 8 Zeichen)</label><input type="password" name="password" minlength="8" maxlength="200" autocomplete="new-password" required></div>
      <button class="primary">Account erstellen</button>
      <p class="small muted">Schon registriert? <a href="#/login">Anmelden</a></p>
    </form></div></div>`;
}

function viewProfile() {
  if (!state.me) return viewLogin();
  return `<div class="auth-wrap"><div class="card auth-box reveal"><span class="eyebrow">Dein Account</span><h1>Profil</h1>
    <form data-form="profile" class="stack">
      <div><label>Anzeigename</label><input name="name" maxlength="60" required value="${esc(state.me.name)}"></div>
      <div><label>Aktuelles Passwort (nur für Passwortwechsel)</label><input type="password" name="currentPassword" autocomplete="current-password"></div>
      <div><label>Neues Passwort (min. 8 Zeichen)</label><input type="password" name="newPassword" minlength="8" maxlength="200" autocomplete="new-password"></div>
      <button class="primary">Speichern</button>
      <p class="small muted">Beim Passwortwechsel werden alle anderen Sitzungen abgemeldet.</p>
    </form></div></div>`;
}

// ---------------------------------------------------------------- effekte

const revealObserver =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.classList.add('in');
            if (e.target.querySelector('[data-count]')) countUp(e.target);
            revealObserver.unobserve(e.target);
          }
        },
        { threshold: 0, rootMargin: '0px 0px -60px 0px' }
      )
    : null;

function countUp(root) {
  for (const el of root.querySelectorAll('[data-count]')) {
    const target = Number(el.dataset.count) || 0;
    if (reducedMotion || target === 0) {
      el.textContent = target.toLocaleString('de-DE');
      continue;
    }
    const start = performance.now();
    const dur = 1400;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString('de-DE');
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/** Nach jedem Rendern: Animationen, Balken, 3D-Effekte anbinden */
function enhance(root, animate) {
  for (const el of root.querySelectorAll('[data-i]')) el.style.setProperty('--i', el.dataset.i);
  for (const el of root.querySelectorAll('[data-w]')) el.style.setProperty('--w', el.dataset.w + '%');
  for (const el of root.querySelectorAll('.bar')) el.classList.add('in');
  bindTips(root);
  for (const el of root.querySelectorAll('[data-z]')) el.style.transform = `translateZ(${el.dataset.z}px)`;
  const steps = root.querySelector('.steps[data-step]');
  if (steps) {
    const n = Number(steps.dataset.step);
    requestAnimationFrame(() => steps.style.setProperty('--step-progress', String(n >= 3 ? 1 : n / 3)));
  }

  const targets = root.querySelectorAll('.reveal, .reveal-flip, .reveal-rise');
  if (!animate || !revealObserver || reducedMotion) {
    targets.forEach((el) => el.classList.add('in'));
    countUp(root);
  } else {
    targets.forEach((el) => revealObserver.observe(el));
  }

  if (!reducedMotion && window.matchMedia('(hover: hover)').matches) {
    for (const el of root.querySelectorAll('.tilt')) bindTilt(el);
  }
}

function bindTilt(el) {
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.classList.add('tilting');
    el.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    el.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
    el.style.setProperty('--mx', `${x * 100}%`);
    el.style.setProperty('--my', `${y * 100}%`);
  });
  el.addEventListener('pointerleave', () => {
    el.classList.remove('tilting');
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  });
}

// Scroll-gekoppelte Effekte: Fortschrittsbalken, Header, Hintergrund, Dartscheibe
let scrollTicking = false;
function onScroll() {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    document.documentElement.style.setProperty('--progress', max > 0 ? (y / max).toFixed(4) : '0');
    document.documentElement.style.setProperty('--scroll', String(Math.round(y)));
    document.getElementById('topbar').classList.toggle('scrolled', y > 10);
    const board = document.getElementById('board');
    if (board && !reducedMotion) board.style.setProperty('--brz', `${Math.min(y * 0.04, 40).toFixed(1)}deg`);
    scrollTicking = false;
  });
}
window.addEventListener('scroll', onScroll, { passive: true });

// Dartscheibe folgt dem Mauszeiger
window.addEventListener(
  'pointermove',
  (e) => {
    const board = document.getElementById('board');
    if (!board || reducedMotion) return;
    const x = e.clientX / window.innerWidth - 0.5;
    const y = e.clientY / window.innerHeight - 0.5;
    board.style.setProperty('--bry', `${(x * 26).toFixed(2)}deg`);
    board.style.setProperty('--brx', `${(-y * 20).toFixed(2)}deg`);
  },
  { passive: true }
);

// ---------------------------------------------------------------- router

async function route(silent = false) {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!silent) {
    clearInterval(state.refreshTimer);
    state.editing = null;
  }
  renderChrome();
  hideTip();
  const scrollY = window.scrollY;
  try {
    let html;
    if (!parts.length) html = await viewHome();
    else if (parts[0] === 'events' && parts[1]) html = await viewEvent(parts[1], parts[2]);
    else if (parts[0] === 'events') html = await viewEvents();
    else if (parts[0] === 'seasons' && parts[1]) html = await viewSeason(parts[1]);
    else if (parts[0] === 'seasons') html = await viewSeasons();
    else if (parts[0] === 'players' && parts[1]) html = await viewPlayer(parts[1]);
    else if (parts[0] === 'players') html = await viewPlayers();
    else if (parts[0] === 'stats') html = await viewStats();
    else if (parts[0] === 'login') html = viewLogin();
    else if (parts[0] === 'register') html = viewRegister();
    else if (parts[0] === 'profile') html = viewProfile();
    else html = '<div class="card empty"><div class="big">🎯</div><h1>Daneben geworfen</h1>Diese Seite gibt es nicht. <a href="#/">Zur Übersicht</a></div>';
    $app.innerHTML = html;
    if (silent) {
      window.scrollTo(0, scrollY);
    } else {
      $app.classList.remove('page-enter');
      void $app.offsetWidth;
      $app.classList.add('page-enter');
      window.scrollTo(0, 0);
    }
    enhance($app, !silent);
    onScroll();
  } catch (e) {
    $app.innerHTML = `<div class="card"><h2>Fehler</h2><p>${esc(e.message)}</p></div>`;
  }
}

async function refreshMe() {
  const r = await api('GET', '/api/me');
  state.me = r.user;
  state.approved = r.approved !== false;
  state.needsSetup = r.needsSetup;
  state.registrationOpen = r.registrationOpen;
  state.requireApproval = r.requireApproval;
  state.users = null;
}

// ---------------------------------------------------------------- aktionen

const evUrl = (suffix = '') => `/api/events/${encodeURIComponent(state.event.id)}${suffix}`;
const enc = encodeURIComponent;

async function afterEventChange(msg) {
  state.users = null;
  state.editing = null;
  if (msg) toast(msg);
  await route(true);
}

const actions = {
  menu() {
    const bar = document.getElementById('topbar');
    const open = bar.classList.toggle('open');
    bar.querySelector('.menu-toggle').setAttribute('aria-expanded', String(open));
  },
  async logout() {
    await api('POST', '/api/logout');
    await refreshMe();
    location.hash = '#/';
    toast('Abgemeldet');
    route();
  },
  async 'register-self'() {
    await api('POST', evUrl('/register'));
    afterEventChange('Angemeldet – viel Erfolg! 🎯');
  },
  async 'join-entry'(el) {
    await api('POST', evUrl(`/entries/${enc(el.dataset.entry)}/join`));
    afterEventChange('Team beigetreten');
  },
  async 'entry-remove'(el) {
    if (!confirm('Anmeldung wirklich entfernen?')) return;
    await api('DELETE', evUrl(`/entries/${enc(el.dataset.entry)}`));
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
    await route(true);
    document.querySelector(`form[data-match="${CSS.escape(el.dataset.match)}"] input`)?.focus();
  },
  async 'undo-round'(el) {
    if (!confirm('Die zuletzt ausgeloste Runde dieses Cups löschen?')) return;
    await api('POST', evUrl(`/cups/${enc(el.dataset.cup)}/undo`));
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
  async 'player-season'(el) {
    const id = location.hash.split('/')[2];
    state.playerSeason[id] = el.dataset.season;
    route(true);
  },
  async 'stats-season'(el) {
    state.statsSeason = el.dataset.season;
    route(true);
  },
  async 'season-filter'(el) {
    state.seasonFilter = el.dataset.filter;
    route(true);
  },
  async 'season-delete'() {
    if (!confirm('Season löschen?')) return;
    await api('DELETE', `/api/seasons/${enc(state.season.id)}`);
    location.hash = '#/seasons';
  },
  async 'user-rename'(el) {
    const u = state.users.find((x) => x.id === el.dataset.user);
    const name = prompt('Neuer Name', u?.name || '');
    if (!name) return;
    await api('PUT', `/api/users/${enc(el.dataset.user)}`, { name });
    route(true);
  },
  async 'user-password'(el) {
    const u = state.users.find((x) => x.id === el.dataset.user);
    const password = prompt(`Neues Passwort für ${u?.name} (min. 8 Zeichen). Alle Sitzungen des Benutzers werden beendet.`);
    if (!password) return;
    await api('PUT', `/api/users/${enc(el.dataset.user)}`, { password });
    toast('Passwort gesetzt');
  },
  async 'user-approve'(el) {
    await api('PUT', `/api/users/${enc(el.dataset.user)}`, { approved: true });
    toast('Account freigeschaltet');
    route(true);
  },
  async 'user-role'(el) {
    await api('PUT', `/api/users/${enc(el.dataset.user)}`, { role: el.dataset.role });
    toast('Rolle geändert');
    route(true);
  },
  async 'user-delete'(el) {
    if (!confirm('Benutzer löschen?')) return;
    await api('DELETE', `/api/users/${enc(el.dataset.user)}`);
    toast('Benutzer gelöscht');
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
    toast(state.me.role === 'admin' ? 'Account erstellt – du bist Administrator.' : state.approved ? 'Account erstellt!' : 'Account erstellt – wartet auf Freischaltung.');
    location.hash = '#/';
  },
  async profile(f) {
    await api('PUT', '/api/me', f);
    await refreshMe();
    toast('Profil gespeichert');
    route();
  },
  async settings(f) {
    await api('PUT', '/api/settings', { registrationOpen: !!f.registrationOpen, requireApproval: !!f.requireApproval });
    await refreshMe();
    toast('Einstellungen gespeichert');
    route(true);
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
    afterEventChange('Angemeldet – viel Erfolg! 🎯');
  },
  async 'team-name'(f, form) {
    await api('PUT', evUrl(`/entries/${enc(form.dataset.entry)}`), { teamName: f.teamName });
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
    await api('POST', evUrl(`/matches/${enc(form.dataset.match)}/result`), { legsA: Number(f.legsA), legsB: Number(f.legsB) });
    afterEventChange('Ergebnis gespeichert');
  },
  async 'season-create'(f) {
    const s = await api('POST', '/api/seasons', seasonPayload(f));
    toast('Season angelegt');
    location.hash = `#/seasons/${s.id}`;
  },
  async 'season-edit'(f) {
    await api('PUT', `/api/seasons/${enc(state.season.id)}`, seasonPayload(f));
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
