'use strict';

/* ======================================================================
 * Statistik-Ansichten: Spielerprofil, Bestenlisten & Archiv, Turnier-Statistik.
 * Wird vor app.js geladen und nutzt dessen Hilfsfunktionen (esc, api, …)
 * erst zur Laufzeit.
 * ==================================================================== */

const STAGE_SHORT = { Q: 'Vorrunde', W: 'Winners', L: 'Losers', SF: 'Halbfinale', F: 'Finale' };

function playerLink(id, name) {
  return id ? `<a class="plink" href="#/players/${esc(id)}">${esc(name)}</a>` : esc(name);
}

function pct(v) {
  return v === null || v === undefined ? '–' : `${String(v).replace('.', ',')} %`;
}

function signed(v) {
  return v > 0 ? `+${v}` : String(v);
}

function fmtNum(v) {
  return Number(v || 0).toLocaleString('de-DE');
}

function seasonFilterRow(seasons, current, action) {
  if (!seasons.length) return '';
  return `<div class="row filter-row reveal" role="group" aria-label="Zeitraum">
    <button class="small ${!current ? 'primary' : ''}" data-action="${action}" data-season="">Gesamt</button>
    ${seasons.map((s) => `<button class="small ${current === s.id ? 'primary' : ''}" data-action="${action}" data-season="${esc(s.id)}">${esc(s.name)}</button>`).join('')}
  </div>`;
}

function tiles(list) {
  return `<div class="tiles">${list
    .map(
      (t, i) => `<div class="tile reveal" data-i="${i}"><span class="tile-label">${esc(t.label)}</span>
        <span class="tile-value">${t.count !== undefined ? `<b data-count="${Number(t.count) || 0}">0</b>${t.suffix ? esc(t.suffix) : ''}` : `<b>${esc(t.value)}</b>`}</span>
        ${t.sub ? `<span class="tile-sub">${esc(t.sub)}</span>` : ''}</div>`
    )
    .join('')}</div>`;
}

// ---------------------------------------------------------------- diagramme

function niceScale(max, ticks = 4) {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= raw);
  return { max: Math.ceil(max / step) * step, step };
}

/**
 * Säulendiagramm (eine Kennzahl, Farbe = Cup-Zugehörigkeit).
 * items: [{ label, value, cls, tipTitle, tipValue }]
 */
function columnChart(items, { title, height = 230 } = {}) {
  // Auf schmalen Bildschirmen schmaler zeichnen, damit die Schrift nicht mitschrumpft
  const W = Math.max(320, Math.min(640, (document.getElementById('app')?.clientWidth || 640) - 40));
  const H = height;
  const L = 34;
  const R = 8;
  const Tp = 22;
  const B = 30;
  const plotW = W - L - R;
  const plotH = H - Tp - B;
  const n = items.length;
  const { max, step } = niceScale(Math.max(...items.map((i) => i.value), 0));
  const band = plotW / Math.max(n, 1);
  const bw = Math.min(24, band * 0.62);
  const y = (v) => Tp + plotH * (1 - v / max);
  const every = Math.ceil(n / Math.max(3, Math.floor(W / 64)));
  const peak = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);

  let grid = '';
  for (let v = 0; v <= max; v += step) {
    grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text class="axis" x="${L - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="central">${fmtNum(v)}</text>`;
  }
  let bars = '';
  items.forEach((it, i) => {
    const x0 = L + band * i + (band - bw) / 2;
    const top = y(it.value);
    const h = Tp + plotH - top;
    const r = Math.min(4, h, bw / 2);
    if (h > 0) {
      bars += `<path class="mark ${esc(it.cls)}" d="M${x0} ${Tp + plotH}V${top + r}Q${x0} ${top} ${x0 + r} ${top}H${x0 + bw - r}Q${x0 + bw} ${top} ${x0 + bw} ${top + r}V${Tp + plotH}Z"/>`;
    }
    if (i === peak && it.value > 0) {
      bars += `<text class="value" x="${x0 + bw / 2}" y="${top - 7}" text-anchor="middle">${fmtNum(it.value)}</text>`;
    }
    if (i % every === 0 || i === n - 1) {
      bars += `<text class="axis" x="${L + band * i + band / 2}" y="${H - 10}" text-anchor="middle">${esc(it.label)}</text>`;
    }
    bars += `<rect class="hit" x="${L + band * i}" y="${Tp}" width="${band}" height="${plotH}" tabindex="0"
      data-tip-title="${esc(it.tipTitle)}" data-tip-value="${esc(it.tipValue)}" aria-label="${esc(it.tipTitle)}: ${esc(it.tipValue)}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title || 'Diagramm')}">
    ${grid}<line class="baseline" x1="${L}" x2="${W - R}" y1="${Tp + plotH}" y2="${Tp + plotH}"/>${bars}</svg>`;
}

function cupLegend(keys) {
  return `<div class="legend">${keys.map((k) => `<span><i class="swatch m-${esc(k)}"></i>${esc(CUP_NAMES[k])}</span>`).join('')}</div>`;
}

/** Horizontale Balken mit Werten am Balkenende */
function hbars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows
    .map(
      (r) => `<div class="hbar" data-tip-title="${esc(r.label)}" data-tip-value="${esc(r.tip || r.value)}">
        <span class="hbar-label">${r.html || esc(r.label)}</span>
        <span class="hbar-track"><i class="m-${esc(r.cls || 'accent')}" data-w="${Math.round((r.value / max) * 100)}"></i></span>
        <span class="hbar-value">${esc(r.display ?? r.value)}</span></div>`
    )
    .join('')}</div>`;
}

function formStrip(form) {
  if (!form.length) return '<p class="muted small">Noch keine Spiele.</p>';
  return `<div class="form-strip" aria-label="Letzte Spiele, älteste zuerst">${form
    .map(
      (f) => `<span class="chip ${f.won ? 'w' : 'l'}" tabindex="0" data-tip-title="${esc(`${STAGE_SHORT[f.stage]} · ${f.eventName}`)}"
        data-tip-value="${esc(`${f.won ? 'Sieg' : 'Niederlage'} ${f.score} gegen ${f.opponent}`)}">${f.won ? 'S' : 'N'}</span>`
    )
    .join('')}</div>`;
}

// Tooltip: Inhalte nur über textContent (Namen sind Nutzereingaben)
let tipEl = null;
function hideTip() {
  tipEl?.classList.remove('show');
}

function bindTips(root) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'chart-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.innerHTML = '<strong></strong><span></span>';
    document.body.appendChild(tipEl);
  }
  const show = (el, x, y) => {
    tipEl.querySelector('strong').textContent = el.dataset.tipValue;
    tipEl.querySelector('span').textContent = el.dataset.tipTitle;
    tipEl.classList.add('show');
    const w = tipEl.offsetWidth;
    tipEl.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
    tipEl.style.top = `${Math.max(8, y - tipEl.offsetHeight - 14)}px`;
    el.classList.add('hover');
  };
  const hide = (el) => {
    tipEl.classList.remove('show');
    el.classList.remove('hover');
  };
  for (const el of root.querySelectorAll('[data-tip-value]')) {
    el.addEventListener('pointermove', (e) => show(el, e.clientX, e.clientY));
    el.addEventListener('pointerleave', () => hide(el));
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    });
    el.addEventListener('blur', () => hide(el));
  }
}

// ---------------------------------------------------------------- spielerprofil

async function viewPlayer(id) {
  const season = state.playerSeason?.[id] || '';
  const s = await api('GET', `/api/players/${encodeURIComponent(id)}/stats${season ? `?season=${encodeURIComponent(season)}` : ''}`);
  const t = s.total;
  const sum = s.summary;
  const isMe = state.me?.id === s.player.id;

  const finished = [...s.history].reverse().filter((h) => h.status === 'finished');
  const shown = finished.slice(-24);
  const cupsUsed = ['pro', 'advanced', 'beginner'].filter((k) => shown.some((h) => h.cup === k));
  const pointsChart = shown.length
    ? `<div class="card reveal"><div class="spread"><h3>Punkte je Turnier</h3>${cupsUsed.length > 1 ? cupLegend(cupsUsed) : ''}</div>
        ${columnChart(
          shown.map((h) => ({
            label: fmtDate(h.date).slice(0, 6) || '–',
            value: h.points,
            cls: `m-${h.cup || 'accent'}`,
            tipTitle: `${h.name}${h.cup ? ' · ' + CUP_NAMES[h.cup] : ''}${h.place ? ' · Platz ' + h.place : ''}`,
            tipValue: `${h.points} Punkte`,
          })),
          { title: 'Punkte je Turnier' }
        )}
        ${finished.length > shown.length ? `<p class="small muted">Die letzten ${shown.length} Turniere – alle stehen in der Historie unten.</p>` : ''}
      </div>`
    : '';

  const cupRows = ['pro', 'advanced', 'beginner'].map((k) => ({
    label: CUP_NAMES[k],
    html: `<i class="swatch m-${k}"></i>${esc(CUP_NAMES[k])}`,
    value: s.cupCounts[k],
    cls: k,
    display: `${s.cupCounts[k]}×`,
    tip: `${s.cupCounts[k]}× gespielt${s.bestPlace[k] ? `, beste Platzierung: ${s.bestPlace[k]}.` : ''}`,
  }));

  const splitRow = (label, r) =>
    `<tr><td>${label}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.lost}</td><td class="num">${pct(r.winRate)}</td><td class="num">${signed(r.legDiff)}</td></tr>`;

  return `
    <div class="page-head player-head">
      <span class="avatar xl reveal">${initials(s.player.name)}</span>
      <div><span class="eyebrow reveal">${isMe ? 'Meine Statistiken' : s.player.guest ? 'Gastspieler' : 'Spielerprofil'}</span>
      <h1 class="reveal">${esc(s.player.name)}</h1>
      ${sum.current ? `<div class="meta-line reveal"><span>${sum.current.type === 'W' ? '🔥' : '❄️'} Aktuelle Serie: ${esc(sum.current.count)} ${sum.current.type === 'W' ? (sum.current.count === 1 ? 'Sieg' : 'Siege') : sum.current.count === 1 ? 'Niederlage' : 'Niederlagen'}</span></div>` : ''}</div>
    </div>
    ${seasonFilterRow(s.seasons, season, 'player-season')}
    ${
      !sum.events
        ? `<div class="card empty mt"><div class="big">🎯</div>${isMe ? 'Du hast' : esc(s.player.name) + ' hat'} in diesem Zeitraum noch an keinem Turnier teilgenommen.</div>`
        : `
    ${tiles([
      { label: 'Turniere', count: sum.events },
      { label: 'Titel', count: sum.titles, sub: `${sum.finals} Finals · ${sum.semis} Halbfinals` },
      { label: 'Siegquote', value: pct(t.winRate), sub: `${t.won} Siege · ${t.lost} Niederlagen` },
      { label: 'Leg-Differenz', value: signed(t.legDiff), sub: `${t.legsFor} : ${t.legsAgainst} Legs` },
      { label: 'Season-Punkte', count: sum.points, sub: `aus ${sum.finishedEvents} abgeschlossenen Turnieren` },
      { label: 'Längste Siegesserie', count: sum.longestWinStreak, sub: `${sum.whitewashes} Siege zu Null` },
    ])}

    <div class="card reveal mt"><div class="spread"><h3>Form · letzte ${esc(s.form.length)} Spiele</h3><span class="small muted">älteste links, neueste rechts</span></div>${formStrip(s.form)}</div>

    <div class="grid-2">
      ${pointsChart}
      <div class="card reveal" data-i="1"><h3>Cup-Einteilung</h3>${hbars(cupRows)}
        <div class="mini-facts">
          ${['pro', 'advanced', 'beginner'].map((k) => (s.bestPlace[k] ? `<span>Beste Platzierung ${esc(CUP_NAMES[k])}: <strong>${esc(s.bestPlace[k])}.</strong></span>` : '')).join('')}
          <span>Entscheidungslegs: <strong>${esc(sum.deciders.won)}–${esc(sum.deciders.lost)}</strong></span>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card reveal"><h3>Bilanz nach Phase & Modus</h3><div class="table-wrap"><table>
        <thead><tr><th></th><th class="num">Spiele</th><th class="num">S</th><th class="num">N</th><th class="num">Quote</th><th class="num">Legs ±</th></tr></thead>
        <tbody>${splitRow('Vorrunde', s.byStage.quali)}${splitRow('Cup (Brackets)', s.byStage.cups)}${splitRow('Halbfinale & Finale', s.byStage.finals)}
        ${s.byMode.single.played ? splitRow('Einzel', s.byMode.single) : ''}${s.byMode.double.played ? splitRow('Doppel', s.byMode.double) : ''}</tbody></table></div></div>
      <div class="card reveal" data-i="1"><h3>Direkter Vergleich</h3>
        ${s.favourite || s.nemesis ? `<div class="mini-facts">${s.favourite ? `<span>😎 Lieblingsgegner: ${playerLink(s.favourite.userId, s.favourite.name)} (${esc(s.favourite.won)}–${esc(s.favourite.lost)})</span>` : ''}${s.nemesis ? `<span>😤 Angstgegner: ${playerLink(s.nemesis.userId, s.nemesis.name)} (${esc(s.nemesis.won)}–${esc(s.nemesis.lost)})</span>` : ''}</div>` : ''}
        ${
          s.headToHead.length
            ? `<div class="table-wrap"><table><thead><tr><th>Gegner</th><th class="num">Spiele</th><th class="num">S–N</th><th>Quote</th></tr></thead><tbody>${s.headToHead
                .slice(0, 10)
                .map(
                  (h) => `<tr><td>${playerLink(h.userId, h.name)}</td><td class="num">${esc(h.played)}</td><td class="num">${esc(h.won)}–${esc(h.lost)}</td>
                  <td class="bar-cell"><div class="bar"><i data-w="${Math.round(h.winRate || 0)}"></i></div></td></tr>`
                )
                .join('')}</tbody></table></div>`
            : '<p class="muted small">Noch keine Begegnungen.</p>'
        }
      </div>
    </div>

    ${
      s.partners.length
        ? `<div class="card reveal"><h3>Doppel-Partner</h3><div class="table-wrap"><table><thead><tr><th>Partner</th><th class="num">Turniere</th><th class="num">Spiele</th><th class="num">S–N</th><th class="num">Quote</th></tr></thead><tbody>${s.partners
            .map((p) => `<tr><td>${playerLink(p.userId, p.name)}</td><td class="num">${esc(p.eventCount)}</td><td class="num">${esc(p.played)}</td><td class="num">${esc(p.won)}–${esc(p.lost)}</td><td class="num">${pct(p.winRate)}</td></tr>`)
            .join('')}</tbody></table></div></div>`
        : ''
    }

    <div class="section-head"><div><span class="eyebrow reveal">Archiv</span><h2 class="reveal">Turnierhistorie</h2></div></div>
    <div class="card flush reveal"><div class="table-wrap"><table>
      <thead><tr><th>Datum</th><th>Turnier</th><th>Modus</th><th>Vorrunde</th><th>Cup</th><th class="num">Platz</th><th class="num">Spiele S–N</th><th class="num">Legs</th><th class="num">Punkte</th></tr></thead>
      <tbody>${s.history
        .map(
          (h) => `<tr><td>${esc(fmtDate(h.date))}</td>
          <td><a href="#/events/${esc(h.eventId)}/stats">${esc(h.name)}</a>${h.status !== 'finished' ? ' <span class="badge cups"><i class="live-dot"></i>läuft</span>' : ''}</td>
          <td>${esc(MODE_LABEL[h.mode])}${h.partner ? `<br><span class="small muted">mit ${esc(h.partner)}</span>` : ''}</td>
          <td>${h.quali ? `${esc(h.quali.rank)}. von ${esc(h.quali.of)}<br><span class="small muted">${esc(h.quali.wins)}–${esc(h.quali.losses)}</span>` : '–'}</td>
          <td>${cupTag(h.cup)}</td>
          <td class="num">${h.place ? (h.category === 'winner' ? '🏆 ' : '') + esc(h.place) + '.' : '–'}</td>
          <td class="num">${esc(h.record.won)}–${esc(h.record.lost)}</td>
          <td class="num">${signed(h.record.legDiff)}</td>
          <td class="num"><strong>${h.points ?? '–'}</strong></td></tr>`
        )
        .join('')}</tbody></table></div></div>`
    }`;
}

// ---------------------------------------------------------------- bestenlisten & archiv

const BOARDS = [
  ['points', 'Meiste Punkte', (r) => `${fmtNum(r.value)} P.`],
  ['titles', 'Meiste Titel', (r) => `${r.value}× 🏆`],
  ['wins', 'Meiste Siege', (r) => `${r.value}`],
  ['winRate', 'Beste Siegquote', (r) => pct(r.value)],
  ['legDiff', 'Beste Leg-Differenz', (r) => signed(r.value)],
  ['streak', 'Längste Siegesserie', (r) => `${r.value} in Folge`],
  ['events', 'Meiste Turniere', (r) => `${r.value}`],
  ['whitewashes', 'Meiste Siege zu Null', (r) => `${r.value}`],
];

async function viewStats() {
  const season = state.statsSeason || '';
  const [o, seasons] = await Promise.all([
    api('GET', `/api/stats/overview${season ? `?season=${encodeURIComponent(season)}` : ''}`),
    api('GET', '/api/seasons'),
  ]);
  const t = o.totals;
  const rec = o.records;

  const board = ([key, title, fmt], i) => {
    const rows = o.leaderboards[key] || [];
    return `<div class="card leaderboard reveal" data-i="${i % 4}"><h3>${esc(title)}</h3>
      ${key === 'winRate' ? `<p class="small muted">mind. ${esc(o.minMatches)} Spiele</p>` : ''}
      ${
        rows.length
          ? `<ol>${rows
              .slice(0, 5)
              .map((r, j) => `<li class="${r.userId === state.me?.id ? 'me' : ''}"><span class="lb-rank">${j + 1}</span><span class="lb-name">${playerLink(r.userId, r.name)}</span><span class="lb-value">${esc(fmt(r))}</span></li>`)
              .join('')}</ol>`
          : '<p class="muted small">Noch keine Daten.</p>'
      }</div>`;
  };

  return `<div class="page-head"><span class="eyebrow reveal">Zahlen & Rekorde</span><h1 class="reveal">Statistiken</h1></div>
    ${seasonFilterRow(seasons.map((x) => ({ id: x.id, name: x.name })), season, 'stats-season')}
    ${
      !t.events
        ? `<div class="card empty mt"><div class="big">📊</div>Sobald das erste Turnier abgeschlossen ist, erscheinen hier Bestenlisten und Rekorde.</div>`
        : `
    ${tiles([
      { label: 'Turniere', count: t.events },
      { label: 'Spieler', count: t.players },
      { label: 'Spiele', count: t.matches },
      { label: 'Legs', count: t.legs },
      { label: 'Siege zu Null', count: t.whitewashes },
      { label: 'Entscheidungslegs', count: t.deciders },
    ])}

    <div class="section-head"><div><span class="eyebrow reveal">Bestenlisten</span><h2 class="reveal">Die Besten der Besten</h2></div></div>
    <div class="leaderboards">${BOARDS.map(board).join('')}</div>

    <div class="section-head"><div><span class="eyebrow reveal">Rekorde</span><h2 class="reveal">Für die Geschichtsbücher</h2></div></div>
    <div class="grid">
      ${rec.longestStreak ? `<div class="card record tilt reveal"><span class="record-icon lift">🔥</span><h3>Längste Siegesserie</h3><p><strong>${esc(rec.longestStreak.value)}</strong> Siege in Folge – ${playerLink(rec.longestStreak.userId, rec.longestStreak.name)}</p></div>` : ''}
      ${rec.bestQuali ? `<div class="card record tilt reveal" data-i="1"><span class="record-icon lift">🎯</span><h3>Beste Vorrunde</h3><p><strong>${esc(rec.bestQuali.wins)}–${esc(rec.bestQuali.losses)}</strong> (Legs ${esc(signed(rec.bestQuali.legDiff))}) – ${esc(rec.bestQuali.name)}, <a href="#/events/${esc(rec.bestQuali.eventId)}/stats">${esc(rec.bestQuali.eventName)}</a></p></div>` : ''}
      ${rec.biggestField ? `<div class="card record tilt reveal" data-i="2"><span class="record-icon lift">👥</span><h3>Größtes Teilnehmerfeld</h3><p><strong>${esc(rec.biggestField.value)}</strong> ${rec.biggestField.mode === 'double' ? 'Teams' : 'Spieler'} – <a href="#/events/${esc(rec.biggestField.eventId)}/stats">${esc(rec.biggestField.eventName)}</a></p></div>` : ''}
      ${rec.mostMatches ? `<div class="card record tilt reveal" data-i="3"><span class="record-icon lift">⚡</span><h3>Meiste Spiele an einem Abend</h3><p><strong>${esc(rec.mostMatches.value)}</strong> Spiele – <a href="#/events/${esc(rec.mostMatches.eventId)}/stats">${esc(rec.mostMatches.eventName)}</a></p></div>` : ''}
    </div>

    <div class="section-head"><div><span class="eyebrow reveal">Archiv</span><h2 class="reveal">Vergangene Turniere</h2></div></div>
    <div class="card flush reveal"><div class="table-wrap"><table>
      <thead><tr><th>Datum</th><th>Turnier</th><th>Modus</th><th class="num">Teilnehmer</th><th class="num">Spiele</th><th class="num">Legs</th><th>Sieger</th></tr></thead>
      <tbody>${o.archive
        .map(
          (a) => `<tr><td>${esc(fmtDate(a.date))}</td><td><a href="#/events/${esc(a.eventId)}/stats"><strong>${esc(a.name)}</strong></a></td><td>${esc(MODE_LABEL[a.mode])}</td>
          <td class="num">${esc(a.entries)}</td><td class="num">${esc(a.matches)}</td><td class="num">${esc(a.legs)}</td>
          <td>${a.winners.map((w) => `<div class="small"><i class="swatch m-${esc(w.cup)}"></i>${a.mode === 'single' && w.userIds.length === 1 ? playerLink(w.userIds[0], w.name) : esc(w.name)}</div>`).join('')}</td></tr>`
        )
        .join('')}</tbody></table></div></div>`
    }`;
}

// ---------------------------------------------------------------- turnier-statistik (tab)

async function tabStats(ev) {
  if (ev.status === 'registration') return `<div class="card empty"><div class="big">📊</div>Statistiken gibt es ab dem Start der Vorrunde.</div>`;
  const s = await api('GET', `/api/events/${encodeURIComponent(ev.id)}/stats`);
  const t = s.totals;
  const linkEntry = (name) => {
    const e = ev.entries.find((x) => x.name === name);
    return e && e.players.length === 1 ? playerLink(e.players[0].id, name) : esc(name);
  };
  return `
    ${tiles([
      { label: 'Spiele', count: t.matches, sub: `${t.qualiMatches} Vorrunde · ${t.cupMatches} Cups` },
      { label: 'Legs', count: t.legs },
      { label: 'Ø Legs pro Spiel', value: String(t.avgLegs).replace('.', ',') },
      { label: 'Siege zu Null', count: t.whitewashes },
      { label: 'Entscheidungslegs', count: t.deciders },
      { label: 'Freilose', count: t.byes },
    ])}
    ${
      s.championPaths.length
        ? `<div class="section-head"><div><span class="eyebrow reveal">Weg zum Titel</span><h2 class="reveal">So wurden die Sieger Sieger</h2></div></div>
      <div class="grid">${s.championPaths
        .map(
          (p, i) => `<div class="card reveal" data-i="${i}"><h3 class="cup-${esc(p.cup)}">${esc(CUP_NAMES[p.cup])}</h3>
          <p><strong>🏆 ${linkEntry(p.name)}</strong><br><span class="small muted">gesetzt auf ${esc(p.seed)} von ${esc(p.size)}${p.lostOnce ? ' · über das Losers Bracket' : ' · ungeschlagen'}</span></p>
          <ol class="path">${p.matches.map((m) => `<li class="${m.won ? 'w' : 'l'}"><span class="chip ${m.won ? 'w' : 'l'}">${m.won ? 'S' : 'N'}</span><span>${esc(STAGE_SHORT[m.stage])} gegen ${esc(m.opponent)}</span><b>${esc(m.score)}</b></li>`).join('')}</ol></div>`
        )
        .join('')}</div>`
        : ''
    }
    <div class="grid-2 mt-lg">
      <div class="card reveal"><h3>Meiste Siege</h3>${hbars(s.winLeaders.map((r) => ({ label: r.name, html: linkEntry(r.name), value: r.won, display: `${r.won}–${r.lost}`, tip: `${r.won} Siege, ${r.lost} Niederlagen` })))}</div>
      <div class="card reveal" data-i="1"><h3>Meiste gewonnene Legs</h3>${hbars(s.legLeaders.map((r) => ({ label: r.name, html: linkEntry(r.name), value: r.legsFor, display: r.legsFor, tip: `${r.legsFor}:${r.legsAgainst} Legs (${signed(r.legDiff)})` })))}</div>
    </div>
    <div class="grid-2">
      <div class="card reveal"><h3>⚡ Überraschungen</h3><p class="small muted">Siege gegen deutlich besser Gesetzte im Cup</p>
        ${
          s.upsets.length
            ? `<ul class="plain">${s.upsets.map((u) => `<li><strong>${esc(u.winner)}</strong> <span class="muted">(#${esc(u.winnerSeed)})</span> schlägt ${esc(u.loser)} <span class="muted">(#${esc(u.loserSeed)})</span> ${esc(u.score)} <span class="small">${cupTag(u.cup)}</span></li>`).join('')}</ul>`
            : '<p class="muted small">Keine – die Favoriten haben sich durchgesetzt.</p>'
        }</div>
      <div class="card reveal" data-i="1"><h3>💯 Perfekte Vorrunde</h3>
        ${s.perfectQuali.length ? `<p>${s.perfectQuali.map((n) => linkEntry(n)).join(', ')}</p><p class="small muted">alle Vorrundenspiele gewonnen</p>` : '<p class="muted small">Niemand blieb in der Vorrunde ungeschlagen.</p>'}</div>
    </div>`;
}
