'use strict';
const CATS = { study: 'Study', work: 'Work', side: 'Side project' };
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const weekStart = s => { const d = parse(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return ymd(d); };
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200); };

/* ---------- storage: Google Sheets (via Apps Script) or local demo ---------- */
const API = window.FREED_API;
const Store = {
  remote: !!API,
  async call(action, body) {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, ...body }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Server error');
    return j;
  },
  local() { return JSON.parse(localStorage.getItem('freed_db') || '{"users":{}}'); },
  save(db) { localStorage.setItem('freed_db', JSON.stringify(db)); },
  async auth(name, pinHash) {
    if (this.remote) return this.call('auth', { name, pinHash });
    const db = this.local(), u = db.users[name];
    if (u && u.pin !== pinHash) throw new Error('Wrong PIN');
    if (!u) { db.users[name] = { pin: pinHash, records: [] }; this.save(db); }
  },
  async getAll() {
    if (this.remote) return (await this.call('getAll')).users;
    const db = this.local(), out = {};
    for (const n in db.users) out[n] = db.users[n].records;
    return out;
  },
  async upsert(me, record) {
    if (this.remote) {
      for (const k of ['startPhoto', 'endPhoto'])
        if (record.data[k]?.startsWith('data:')) record.data[k] = (await this.call('photo', { ...me, dataUrl: record.data[k] })).url;
      return this.call('upsert', { ...me, record });
    }
    const db = this.local(), recs = db.users[me.name].records, i = recs.findIndex(r => r.id === record.id);
    i >= 0 ? recs[i] = record : recs.push(record);
    this.save(db);
  },
  async remove(me, id) {
    if (this.remote) return this.call('remove', { ...me, id });
    const db = this.local(), u = db.users[me.name];
    u.records = u.records.filter(r => r.id !== id);
    this.save(db);
  },
};

async function hashPin(name, pin) {
  const s = `freed:${name.toLowerCase()}:${pin}`;
  if (!crypto.subtle) return btoa(s);
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function resizeImage(file, max = 720) {
  const url = URL.createObjectURL(file), img = new Image();
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
  const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = img.width * k; c.height = img.height * k;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return c.toDataURL('image/jpeg', 0.7);
}

/* ---------- state & helpers ---------- */
const S = { me: null, db: {}, view: 'today', who: null, month: new Date(), sel: today(), period: 'week', backfill: false, menu: false, confirmDel: null };
const pending = {};                       // photo inputs -> data URLs
const recs = (u, type) => (S.db[u] || []).filter(r => r.type === type);
const sessions = u => recs(u, 'session').filter(r => r.data.status === 'done');
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const ratings = ss => ss.flatMap(s => s.data.tasks.map(t => t.rating).filter(Boolean));
const dayAvg = (u, d) => avg(ratings(sessions(u).filter(s => s.date === d)));
function streak(u) {
  const days = new Set(sessions(u).map(s => s.date)); let d = new Date(), n = 0;
  if (!days.has(ymd(d))) d.setDate(d.getDate() - 1);
  while (days.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function stats(u, from = '0000') {
  const ss = sessions(u).filter(s => s.date >= from), rs = ratings(ss);
  return { points: rs.reduce((a, b) => a + b, 0), avg: avg(rs), sessions: ss.length, tasks: rs.length };
}
async function refresh() { try { S.db = await Store.getAll(); } catch (e) { toast(e.message); } }
async function persist(rec) {
  const i = (S.db[S.me.name] ||= []).findIndex(r => r.id === rec.id);
  i >= 0 ? S.db[S.me.name][i] = rec : S.db[S.me.name].push(rec);
  try { await Store.upsert(S.me, rec); } catch (e) { toast('Save failed: ' + e.message); throw e; }
}

/* ---------- views ---------- */
const ICONS = {
  today: '<path d="M3 17.5V21h3.5L18 9.5 14.5 6 3 17.5zM16 4.5l3.5 3.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  leaderboard: '<path d="M6 20V11M12 20V4M18 20v-6"/>',
  profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.5 3.6-5 7-5s6.2 1.5 7 5"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = (n, s = 16) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const hue = n => [...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (n, cls = '') => `<span class="av ${cls}" style="--h:${hue(n)}">${esc(n[0].toUpperCase())}</span>`;
const pill = c => `<span class="pill ${c}">${CATS[c]}</span>`;
const RATE_WORDS = ['', 'Barely started', 'Some of it', 'About half', 'Mostly done', 'Finished it'];
const fmtDay = s => parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmt1 = n => n ? n.toFixed(1) : '–';
const hour = () => new Date().getHours();

const catSeg = () => `<div class="seg cat" role="group" aria-label="Category">${Object.entries(CATS).map(([k, v], i) => `<button type="button" class="${i ? '' : 'on'}" data-act="cat" data-v="${k}">${v}</button>`).join('')}</div>`;
const taskRow = (rate) => `<div class="trow"><input class="t-text" placeholder="What will you finish?" aria-label="Task">${catSeg()}${rate ? rateRow() : ''}<button class="x" data-act="rmRow" aria-label="Remove task">${icon('close', 14)}</button></div>`;
const rateRow = () => `<div class="rate" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-act="rate" data-v="${i}" title="${RATE_WORDS[i]}">${i}</button>`).join('')}<span class="rl muted small"></span></div>`;
const photoBox = (id, label) => `<label class="photo" id="ph-${id}"><input type="file" accept="image/*" capture="user" hidden data-photo="${id}">${icon('camera', 22)}<span>${label}</span></label>`;

function rankOf(name, from) {
  const rows = Object.keys(S.db).map(n => ({ n, ...stats(n, from) })).sort((a, b) => b.points - a.points || b.avg - a.avg);
  return { rank: rows.findIndex(r => r.n === name) + 1, of: rows.length, rows };
}

function sessionCard(s, ro, compact) {
  const d = s.data, a = avg(d.tasks.map(x => x.rating).filter(Boolean));
  const del = S.confirmDel === s.id ? `<button class="link danger" data-act="delSession" data-id="${s.id}">Confirm delete</button>` : `<button class="link" data-act="delSession" data-id="${s.id}">Delete</button>`;
  return `<article class="sess">
    <header class="row"><h3 class="grow">${compact ? '' : fmtDay(s.date) + ' · '}${d.startedAt ? esc(d.startedAt) + (d.endedAt ? ' to ' + esc(d.endedAt) : '') : 'Logged afterwards'}</h3>${a ? `<span class="fig">${fmt1(a)}<span class="unit">/5</span></span>` : ''}${ro ? '' : del}</header>
    ${d.startPhoto || d.endPhoto ? `<div class="photos">${['startPhoto', 'endPhoto'].map(k => d[k] ? `<figure><img class="thumb" src="${esc(d[k])}" alt="${k === 'startPhoto' ? 'Start' : 'End'} of session"><figcaption class="muted small">${k === 'startPhoto' ? 'Start' : 'End'}</figcaption></figure>` : '').join('')}</div>` : ''}
    <ul class="tasks">${d.tasks.map(x => `<li>${pill(x.cat)}<span class="grow">${esc(x.text)}</span><span class="fig sm">${x.rating ? x.rating + '<span class="unit">/5</span>' : '–'}</span></li>`).join('')}</ul>
    ${d.note ? `<p class="muted small note">${esc(d.note)}</p>` : ''}</article>`;
}

function goalsHTML() {
  const me = S.me.name, t = today(), wk = weekStart(t);
  const block = (kind, anchor, title) => {
    const gs = recs(me, 'goal').filter(g => g.data.kind === kind && g.date === anchor);
    return `<h3 class="sub">${title}</h3>${gs.map(g => `<label class="goal ${g.data.done ? 'done' : ''}"><input type="checkbox" data-act="toggleGoal" data-id="${g.id}" ${g.data.done ? 'checked' : ''}><span class="grow">${esc(g.data.text)}</span><button class="x" data-act="delGoal" data-id="${g.id}" aria-label="Remove goal">${icon('close', 14)}</button></label>`).join('') || `<div class="muted small">Nothing set.</div>`}
      <div class="row add"><input class="grow" id="g-${kind}" placeholder="Add a ${kind} goal" aria-label="New ${kind} goal"><button class="btn sm" data-act="addGoal" data-kind="${kind}">Add</button></div>`;
  };
  return `<section class="panel"><h2>Goals</h2>${block('weekly', wk, 'This week')}${block('daily', t, 'Today')}</section>`;
}

function viewToday() {
  const me = S.me.name, active = recs(me, 'session').find(s => s.data.status === 'active');
  const done = sessions(me).filter(s => s.date === today()), td = ratings(done);
  const wkFrom = weekStart(today()), wk = stats(me, wkFrom), rk = rankOf(me, wkFrom);
  const hi = hour() < 12 ? 'Morning' : hour() < 18 ? 'Afternoon' : 'Evening';
  const fact = active ? `A session is running. Rate your ${active.data.tasks.length} task${active.data.tasks.length > 1 ? 's' : ''} when you finish.`
    : td.length ? `${td.length} task${td.length > 1 ? 's' : ''} finished today, averaging ${fmt1(avg(td))} out of 5.`
    : 'Nothing logged yet today. Choose what you will finish and start.';
  const meta = [fmtDay(today()), streak(me) ? `${streak(me)}-day streak` : 'no streak yet', wk.sessions ? `${ordinal(rk.rank)} of ${rk.of} this week` : ''].filter(Boolean).join(' · ');
  let main;
  if (active) {
    const d = active.data;
    main = `<section class="panel"><div class="row"><h2 class="grow">Session in progress</h2><span class="fig" id="elapsed">${elapsed(d)}</span></div>
      <div class="photos"><figure><img class="thumb" src="${esc(d.startPhoto)}" alt="Start of session"><figcaption class="muted small">Started ${esc(d.startedAt)}</figcaption></figure>${photoBox('end', 'Add your end photo')}</div>
      <h3 class="sub">How did each task go?</h3>
      <ul class="tasks rating">${d.tasks.map((t, i) => `<li data-i="${i}">${pill(t.cat)}<span class="grow">${esc(t.text)}</span>${rateRow()}</li>`).join('')}</ul>
      <textarea id="note" rows="2" placeholder="Anything to remember? (optional)" aria-label="Reflection"></textarea>
      <div class="row end"><button class="btn primary" data-act="finish">Finish session</button></div></section>`;
  } else {
    main = `<section class="panel"><h2>New session</h2>
      <div class="split"><div><h3 class="sub">What will you finish before you stop?</h3><div id="rows">${taskRow()}${taskRow()}</div>
      <button class="btn ghost sm" data-act="addRow">Add task</button></div>
      <div><h3 class="sub">Start photo</h3>${photoBox('start', 'Take or upload a photo')}</div></div>
      <div class="row end"><button class="btn primary" data-act="start">Start session</button></div></section>`;
  }
  return `<header class="head"><h1>${hi}, ${esc(me)}.</h1><p class="muted">${esc(fact)}</p><p class="muted small">${esc(meta)}</p></header>
    <div class="g12"><div class="s8">${main}${done.length ? `<section class="panel"><h2>Finished today</h2>${done.map(s => sessionCard(s, false, true)).join('')}</section>` : ''}</div>
    <div class="s4"><section class="panel"><h2>This week</h2><div class="figs"><div><span class="fig lg">${wk.points}</span><span class="muted small">points</span></div><div><span class="fig lg">${wk.sessions}</span><span class="muted small">sessions</span></div><div><span class="fig lg">${fmt1(wk.avg)}</span><span class="muted small">average</span></div></div></section>${goalsHTML()}</div></div>`;
}
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10 < 4 ? n % 10 : 0]);
function elapsed(d) {
  const m = Math.max(0, Math.floor((Date.now() - (d.startedMs || Date.now())) / 60000));
  return `${Math.floor(m / 60)}:${pad(m % 60)}<span class="unit"> h:min</span>`;
}

function calendarPanel(u, ro) {
  const m = S.month, y = m.getFullYear(), mo = m.getMonth(), first = new Date(y, mo, 1), n = new Date(y, mo + 1, 0).getDate();
  const marks = recs(u, 'date'), pre = (first.getDay() + 6) % 7, mp = `${y}-${pad(mo + 1)}`;
  const mss = sessions(u).filter(s => s.date.startsWith(mp)), days = new Set(mss.map(s => s.date)).size;
  let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('') + '<div class="day out"></div>'.repeat(pre);
  for (let i = 1; i <= n; i++) {
    const d = `${mp}-${pad(i)}`, a = dayAvg(u, d), mk = marks.filter(x => x.date === d);
    cells += `<button class="day ${a ? 'r' + Math.round(a) : ''} ${d === today() ? 'today' : ''} ${d === S.sel ? 'sel' : ''}" data-act="selDay" data-d="${d}" aria-label="${fmtDay(d)}${a ? ', rated ' + a.toFixed(1) : ''}"><span class="n">${i}</span>${mk.length ? `<span class="mk">${esc(mk[0].data.label)}</span>` : ''}${a ? `<span class="v">${a.toFixed(1)}</span>` : ''}</button>`;
  }
  return `<section class="panel"><div class="row"><h2 class="grow">${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
    <button class="btn ghost sm" data-act="prevMonth" aria-label="Previous month">Prev</button><button class="btn ghost sm" data-act="thisMonth">Today</button><button class="btn ghost sm" data-act="nextMonth" aria-label="Next month">Next</button></div>
    <p class="muted small">${days} day${days === 1 ? '' : 's'} studied · average ${fmt1(avg(ratings(mss)))} out of 5</p>
    <div class="cal">${cells}</div>
    <div class="legend muted small">Lower<i class="r1"></i><i class="r2"></i><i class="r3"></i><i class="r4"></i><i class="r5"></i>Higher rating</div></section>`;
}

function dayPanel(u, ro) {
  const sel = S.sel, selSs = sessions(u).filter(s => s.date === sel), selMk = recs(u, 'date').filter(x => x.date === sel);
  return `<section class="panel"><h2>${parse(sel).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
    ${selMk.map(x => `<div class="mark"><span class="grow">${esc(x.data.label)}</span>${ro ? '' : `<button class="x" data-act="delMark" data-id="${x.id}" aria-label="Remove date">${icon('close', 14)}</button>`}</div>`).join('')}
    ${ro ? '' : `<div class="row add"><input id="mark" class="grow" placeholder="Mark an important date" aria-label="Important date label"><button class="btn sm" data-act="addMark">Mark</button></div>
    <div class="row"><button class="btn ghost sm" data-act="toggleBackfill">${S.backfill ? 'Cancel' : 'Log a past session'}</button></div>`}
    ${!ro && S.backfill ? `<div class="backfill"><h3 class="sub">Tasks you did</h3><div id="rows">${taskRow(true)}</div><button class="btn ghost sm" data-act="addBfRow">Add task</button>
      <div class="photos">${photoBox('start', 'Start photo')}${photoBox('end', 'End photo')}</div><p class="muted small">Photos are optional for past sessions.</p>
      <div class="row end"><button class="btn primary" data-act="saveBackfill">Save to ${esc(fmtDay(sel))}</button></div></div>` : ''}
    ${selSs.map(s => sessionCard(s, ro, true)).join('') || (S.backfill ? '' : `<p class="muted small">Nothing logged on this day.</p>`)}</section>`;
}

function viewCalendar() {
  return `<header class="head"><h1>Calendar</h1><p class="muted">Your self-rating for every day. Pick a day to mark it or fill it in.</p></header>
    <div class="g12"><div class="s8">${calendarPanel(S.me.name, false)}</div><div class="s4">${dayPanel(S.me.name, false)}</div></div>`;
}

function lastSeen(n) {
  const l = sessions(n).map(s => s.date).sort().pop();
  if (!l) return '–';
  const diff = Math.round((parse(today()) - parse(l)) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : fmtDay(l);
}

function viewLeaderboard() {
  const from = S.period === 'week' ? weekStart(today()) : S.period === 'month' ? today().slice(0, 7) + '-01' : '0000';
  const rows = rankOf(S.me.name, from).rows.map(r => ({ ...r, streak: streak(r.n) })), max = Math.max(1, ...rows.map(r => r.points));
  const label = { week: 'this week', month: 'this month', all: 'of all time' }[S.period];
  const top = rows[0], fact = top && top.points ? `${top.n} leads ${label} with ${top.points} points.` : `No sessions finished ${label} yet.`;
  const tab = (k, l) => `<button class="${S.period === k ? 'on' : ''}" data-act="period" data-k="${k}">${l}</button>`;
  return `<header class="head"><h1>Leaderboard</h1><p class="muted">${esc(fact)}</p></header>
    <section class="panel"><div class="row"><h2 class="grow">Points are the sum of self-ratings</h2><div class="seg">${tab('week', 'Week')}${tab('month', 'Month')}${tab('all', 'All time')}</div></div>
    ${rows.length ? `<div class="scroll"><table><thead><tr><th>#</th><th>Person</th><th class="bar">Points</th><th class="num">Avg</th><th class="num">Sessions</th><th class="num">Streak</th><th>Last session</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="click ${r.n === S.me.name ? 'you' : ''}" tabindex="0" data-act="user" data-n="${esc(r.n)}"><td class="num">${i + 1}</td><td><span class="row">${avatar(r.n)}${esc(r.n)}${r.n === S.me.name ? '<span class="muted small">you</span>' : ''}</span></td>
    <td class="bar"><span class="row"><span class="meter"><i style="width:${Math.round(r.points / max * 100)}%"></i></span><b class="fig sm">${r.points}</b></span></td><td class="num">${fmt1(r.avg)}</td><td class="num">${r.sessions}</td><td class="num">${r.streak || '–'}</td><td class="muted">${lastSeen(r.n)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nobody has joined yet.</p>'}</section>`;
}

function viewProfile(u) {
  const st = stats(u), ro = u !== S.me.name, by = { study: 0, work: 0, side: 0 }, ss = sessions(u).sort((a, b) => b.date.localeCompare(a.date));
  ss.forEach(s => s.data.tasks.forEach(t => by[t.cat]++));
  const recent = ss.slice(0, 4);
  return `<header class="head"><p><button class="link" data-act="nav" data-v="leaderboard">Back to leaderboard</button></p><h1 class="row">${avatar(u, 'lg')}${esc(u)}</h1>
    <p class="muted">${st.sessions ? `${st.sessions} session${st.sessions > 1 ? 's' : ''}, last ${lastSeen(u).toLowerCase()}.` : 'No sessions logged yet.'}</p></header>
    <div class="g12">${[[st.points, 'points'], [fmt1(st.avg), 'average rating'], [st.tasks, 'tasks rated'], [streak(u), 'day streak']].map(([v, l]) => `<section class="panel s3"><span class="fig lg">${v}</span><span class="muted small">${l}</span></section>`).join('')}</div>
    <div class="g12"><div class="s8">${calendarPanel(u, ro)}</div><div class="s4">${dayPanel(u, ro)}</div></div>
    <section class="panel"><h2>Recent sessions</h2><div class="row cats">${Object.keys(CATS).map(c => `${pill(c)}<span class="muted small">${by[c]} task${by[c] === 1 ? '' : 's'}</span>`).join('')}</div>
    <div class="feed">${recent.map(s => sessionCard(s, true)).join('') || '<p class="muted">Nothing yet.</p>'}</div>${!ro ? '<div class="row end"><button class="btn ghost sm" data-act="logout">Log out</button></div>' : ''}</section>`;
}

function render() {
  const app = $('#app');
  if (!S.me) {
    app.innerHTML = `<main class="login"><p class="mark">Freed</p><h1>Study with friends who can see you do it.</h1><p class="muted">Set tasks, take a photo at the start and the end, rate yourself honestly.</p>
      ${Store.remote ? '' : '<p class="banner small">Demo mode: data stays in this browser. Add your Apps Script URL in config.js to sync with Google Sheets.</p>'}
      <label class="field">Name<input id="l-name" autocomplete="username"></label><label class="field">PIN, 4 or more digits<input id="l-pin" type="password" inputmode="numeric" autocomplete="current-password"></label>
      <button class="btn primary wide" data-act="login">Continue</button><p class="muted small">A new name creates your account.</p></main>`;
    return;
  }
  const items = [['today', 'Today'], ['calendar', 'Calendar'], ['leaderboard', 'Leaderboard'], ['me', 'Profile']];
  const on = v => S.view === v || (v === 'me' && S.view === 'profile' && S.who === S.me.name);
  const title = S.view === 'profile' ? (S.who === S.me.name ? 'Profile' : S.who) : items.find(i => i[0] === S.view)[1];
  const nav = `<nav class="nav" aria-label="Main">${items.map(([v, l]) => `<button class="${on(v) ? 'on' : ''}" data-act="nav" data-v="${v}">${icon(v === 'me' ? 'profile' : v)}${l}</button>`).join('')}</nav>`;
  const body = S.view === 'today' ? viewToday() : S.view === 'calendar' ? viewCalendar() : S.view === 'leaderboard' ? viewLeaderboard() : viewProfile(S.who || S.me.name);
  app.innerHTML = `<div class="shell"><aside class="side ${S.menu ? 'open' : ''}"><div class="ws"><span class="logo">F</span><span>Freed</span></div>${nav}<div class="user">${avatar(S.me.name)}<span>${esc(S.me.name)}</span></div></aside>
    <div class="topbar"><span class="grow">${esc(title)}</span><button class="x" data-act="menu" aria-label="Menu">${icon(S.menu ? 'close' : 'menu', 20)}</button></div>
    <main class="canvas">${body}</main></div>`;
}

/* ---------- actions ---------- */
const rowsOf = bf => [...document.querySelectorAll('#rows .trow')].map(r => ({ text: r.querySelector('.t-text').value.trim(), cat: r.querySelector('.cat .on').dataset.v, rating: +(r.querySelector('.rate .on')?.dataset.v || 0) })).filter(t => t.text);
const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const go = (view, who) => { S.view = view; S.who = who || null; S.menu = false; S.backfill = false; S.sel = today(); S.month = new Date(); return refresh().then(render); };

const actions = {
  async login() {
    const name = $('#l-name').value.trim(), pin = $('#l-pin').value;
    if (!/^[\p{L}\p{N} _.-]{2,30}$/u.test(name)) return toast('Name: 2 to 30 letters or numbers');
    if (!/^\d{4,}$/.test(pin)) return toast('PIN must be 4 or more digits');
    try {
      const pinHash = await hashPin(name, pin);
      await Store.auth(name, pinHash);
      S.me = { name, pinHash }; localStorage.setItem('freed_me', JSON.stringify(S.me));
      await refresh(); S.db[name] ||= []; render();
    } catch (e) { toast(e.message); }
  },
  logout() { S.me = null; localStorage.removeItem('freed_me'); render(); },
  menu() { S.menu = !S.menu; render(); },
  nav: a => go(a.dataset.v === 'me' ? 'profile' : a.dataset.v, a.dataset.v === 'me' ? S.me.name : null),
  user: a => go('profile', a.dataset.n),
  period: a => { S.period = a.dataset.k; render(); },
  cat: a => a.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === a)),
  addRow() { $('#rows').insertAdjacentHTML('beforeend', taskRow()); $('#rows .trow:last-child .t-text').focus(); },
  addBfRow() { $('#rows').insertAdjacentHTML('beforeend', taskRow(true)); $('#rows .trow:last-child .t-text').focus(); },
  rmRow: a => { const rows = $('#rows'); if (rows.children.length > 1) a.closest('.trow').remove(); else a.closest('.trow').querySelector('.t-text').value = ''; },
  rate(a) {
    a.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === a));
    a.parentElement.querySelector('.rl').textContent = RATE_WORDS[a.dataset.v];
  },
  async start() {
    const tasks = rowsOf().map(({ text, cat }) => ({ text, cat }));
    if (!tasks.length) return toast('Add at least one task');
    if (!pending.start) return toast('Take your start photo first');
    const rec = { id: uid(), type: 'session', date: today(), data: { status: 'active', startedAt: timeNow(), startedMs: Date.now(), startPhoto: pending.start, tasks } };
    delete pending.start; await persist(rec); toast('Session started'); render();
  },
  async finish() {
    const rec = recs(S.me.name, 'session').find(s => s.data.status === 'active');
    if (!pending.end) return toast('Take your end photo first');
    const rates = [...document.querySelectorAll('.tasks.rating li')].map(li => +(li.querySelector('.rate .on')?.dataset.v || 0));
    if (rates.includes(0)) return toast('Rate every task');
    rec.data.tasks.forEach((t, i) => t.rating = rates[i]);
    Object.assign(rec.data, { status: 'done', endedAt: timeNow(), endPhoto: pending.end, note: $('#note').value.trim() });
    delete pending.end; await persist(rec); toast('Session saved'); render();
  },
  selDay: a => { S.sel = a.dataset.d; S.backfill = false; render(); },
  prevMonth: () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); render(); },
  nextMonth: () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); render(); },
  thisMonth: () => { S.month = new Date(); S.sel = today(); render(); },
  async addMark() {
    const label = $('#mark').value.trim(); if (!label) return;
    await persist({ id: uid(), type: 'date', date: S.sel, data: { label } }); render();
  },
  delMark: a => remove(a.dataset.id),
  toggleBackfill: () => { S.backfill = !S.backfill; delete pending.start; delete pending.end; render(); },
  async saveBackfill() {
    const out = rowsOf();
    if (!out.length) return toast('Add at least one task');
    if (out.some(t => !t.rating)) return toast('Rate every task');
    await persist({ id: uid(), type: 'session', date: S.sel, data: { status: 'done', backfilled: true, startPhoto: pending.start || '', endPhoto: pending.end || '', tasks: out } });
    delete pending.start; delete pending.end; S.backfill = false; toast('Logged'); render();
  },
  async delSession(a) {
    if (S.confirmDel !== a.dataset.id) { S.confirmDel = a.dataset.id; return render(); }
    S.confirmDel = null; await remove(a.dataset.id);
  },
  async addGoal(a) {
    const kind = a.dataset.kind, text = $('#g-' + kind).value.trim(); if (!text) return;
    await persist({ id: uid(), type: 'goal', date: kind === 'weekly' ? weekStart(today()) : today(), data: { kind, text, done: false } }); render();
  },
  async toggleGoal(a) { const g = S.db[S.me.name].find(r => r.id === a.dataset.id); g.data.done = a.checked; await persist(g); render(); },
  delGoal(a, e) { e.preventDefault(); return remove(a.dataset.id); },
};
async function remove(id) {
  S.db[S.me.name] = S.db[S.me.name].filter(r => r.id !== id);
  render();
  try { await Store.remove(S.me, id); } catch (e) { toast('Delete failed: ' + e.message); }
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a && a.type !== 'checkbox' && actions[a.dataset.act]) actions[a.dataset.act](a, e);
});
document.addEventListener('change', async e => {
  if (e.target.dataset.act === 'toggleGoal') return actions.toggleGoal(e.target);
  const id = e.target.dataset.photo;
  if (!id || !e.target.files[0]) return;
  try {
    pending[id] = await resizeImage(e.target.files[0]);
    $('#ph-' + id).innerHTML = `<img src="${pending[id]}" alt="Your photo"><input type="file" accept="image/*" capture="user" hidden data-photo="${id}">`;
  } catch { toast('Could not read that photo'); }
});
document.addEventListener('keydown', e => {
  const t = e.target;
  if (e.key === 'Enter' && t.id === 'l-pin') actions.login();
  if (e.key === 'Enter' && t.id === 'mark') actions.addMark();
  if (e.key === 'Enter' && t.id?.startsWith('g-')) actions.addGoal({ dataset: { kind: t.id.slice(2) } });
  if (e.key === 'Enter' && t.classList?.contains('t-text')) {
    const rows = [...document.querySelectorAll('#rows .trow')], i = rows.indexOf(t.closest('.trow'));
    if (i === rows.length - 1) (S.backfill ? actions.addBfRow : actions.addRow)(); else rows[i + 1].querySelector('.t-text').focus();
  }
  if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('tr.click')) { e.preventDefault(); actions.user(t); }
});
setInterval(() => {
  const el = $('#elapsed'), a = S.me && recs(S.me.name, 'session').find(s => s.data.status === 'active');
  if (el && a) el.innerHTML = elapsed(a.data);
}, 30000);

(async function init() {
  try {
    const saved = JSON.parse(localStorage.getItem('freed_me') || 'null');
    if (saved) { await Store.auth(saved.name, saved.pinHash); S.me = saved; await refresh(); S.db[saved.name] ||= []; }
  } catch { localStorage.removeItem('freed_me'); }
  render();
})();
