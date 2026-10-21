'use strict';
const CATS = { study: ['📚', 'Study'], work: ['💼', 'Work'], side: ['🚀', 'Side project'] };
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const weekStart = s => { const d = parse(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return ymd(d); };
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
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
const S = { me: null, db: {}, view: 'today', who: null, month: new Date(), sel: today(), period: 'week', backfill: false };
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
const pill = c => `<span class="pill ${c}">${CATS[c][0]} ${CATS[c][1]}</span>`;
const avatar = n => `<span class="av">${esc(n[0].toUpperCase())}</span>`;
const catOptions = `${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v[0]} ${v[1]}</option>`).join('')}`;
const taskRow = () => `<div class="trow"><input class="t-text" placeholder="What will you finish?"><select class="t-cat">${catOptions}</select><button class="x" data-act="rmRow">✕</button></div>`;
const photoBox = (id, label) => `<label class="photo" id="ph-${id}"><input type="file" accept="image/*" capture="user" hidden data-photo="${id}">📷 ${label}</label>`;
const rateRow = n => `<div class="rate" data-i="${n}">${[1, 2, 3, 4, 5].map(i => `<button data-act="rate" data-v="${i}">${i}</button>`).join('')}</div>`;

function sessionCard(s, ro) {
  const d = s.data, t = d.tasks, a = avg(t.map(x => x.rating).filter(Boolean));
  return `<div class="card"><div class="row"><h3 class="grow">${esc(s.date)} ${d.startedAt ? '· ' + esc(d.startedAt) + (d.endedAt ? '–' + esc(d.endedAt) : '') : '· logged later'}</h3>
    ${a ? `<span class="stars">${stars(Math.round(a))}</span>` : ''}${ro ? '' : `<button class="x" data-act="delSession" data-id="${s.id}">Delete</button>`}</div>
    ${d.startPhoto || d.endPhoto ? `<div class="photos" style="margin:10px 0">${['startPhoto', 'endPhoto'].map(k => d[k] ? `<div><img class="thumb" src="${esc(d[k])}" alt=""><div class="muted small">${k === 'startPhoto' ? 'Start' : 'End'}</div></div>` : '').join('')}</div>` : ''}
    ${t.map(x => `<div class="task">${pill(x.cat)}<span class="grow">${esc(x.text)}</span><span class="stars">${x.rating ? stars(x.rating) : ''}</span></div>`).join('')}
    ${d.note ? `<p class="muted small">${esc(d.note)}</p>` : ''}</div>`;
}

function goalsHTML() {
  const me = S.me.name, t = today(), wk = weekStart(t);
  const block = (kind, anchor, title) => {
    const gs = recs(me, 'goal').filter(g => g.data.kind === kind && g.date === anchor);
    return `<h3 style="margin-top:14px">${title}</h3>${gs.map(g => `<div class="goal ${g.data.done ? 'done' : ''}"><input type="checkbox" data-act="toggleGoal" data-id="${g.id}" ${g.data.done ? 'checked' : ''}><span class="grow">${esc(g.data.text)}</span><button class="x" data-act="delGoal" data-id="${g.id}">✕</button></div>`).join('') || '<div class="muted small">None yet</div>'}
      <div class="row" style="margin-top:6px"><input class="grow" id="g-${kind}" placeholder="Add a ${kind} goal"><button class="btn sm" data-act="addGoal" data-kind="${kind}">Add</button></div>`;
  };
  return `<h2>🎯 Goals</h2>${block('weekly', wk, 'This week')}${block('daily', t, 'Today')}`;
}

function viewToday() {
  const me = S.me.name, active = recs(me, 'session').find(s => s.data.status === 'active');
  const done = sessions(me).filter(s => s.date === today());
  let h = `<h1>Today</h1><div class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · 🔥 ${streak(me)}-day streak</div>`;
  if (active) {
    const d = active.data;
    h += `<h2>Session in progress</h2><div class="card"><div class="photos"><div><img class="thumb" src="${esc(d.startPhoto)}" alt=""><div class="muted small">Started ${esc(d.startedAt)}</div></div>${photoBox('end', 'End-of-session photo')}</div>
      <h3 style="margin-top:14px">Rate each task (1–5)</h3>
      ${d.tasks.map((t, i) => `<div class="task">${pill(t.cat)}<span class="grow">${esc(t.text)}</span>${rateRow(i)}</div>`).join('')}
      <textarea id="note" rows="2" style="width:100%;margin-top:10px" placeholder="Reflection (optional)"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="finish">Finish session</button></div></div>`;
  } else {
    h += `<h2>Start a session</h2><div class="card"><div id="rows">${taskRow()}${taskRow()}</div>
      <button class="btn ghost sm" data-act="addRow">+ Add task</button>
      <div style="margin:14px 0">${photoBox('start', 'Start-of-session photo (required)')}</div>
      <button class="btn" data-act="start">Start session</button></div>`;
  }
  if (done.length) h += `<h2>Done today</h2>${done.map(s => sessionCard(s)).join('')}`;
  return h + goalsHTML();
}

function calendarHTML(u, ro) {
  const m = S.month, y = m.getFullYear(), mo = m.getMonth(), first = new Date(y, mo, 1), n = new Date(y, mo + 1, 0).getDate();
  const marks = recs(u, 'date'), pre = (first.getDay() + 6) % 7;
  const mp = `${y}-${pad(mo + 1)}`, mss = sessions(u).filter(s => s.date.startsWith(mp));
  let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('') + '<div class="day out"></div>'.repeat(pre);
  for (let i = 1; i <= n; i++) {
    const d = `${mp}-${pad(i)}`, a = dayAvg(u, d), mk = marks.filter(x => x.date === d);
    cells += `<div class="day ${a ? 'r' + Math.round(a) : ''} ${d === today() ? 'today' : ''} ${d === S.sel ? 'sel' : ''}" data-act="selDay" data-d="${d}"><span class="n">${i}</span>${mk.map(x => `<div class="mk">⭐ ${esc(x.data.label)}</div>`).join('')}${a ? `<span class="r">${a.toFixed(1)}</span>` : ''}</div>`;
  }
  const sel = S.sel, selSs = sessions(u).filter(s => s.date === sel), selMk = marks.filter(x => x.date === sel);
  return `<div class="row"><button class="btn ghost sm" data-act="prevMonth">←</button><h2 class="grow" style="margin:0;text-align:center">${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2><button class="btn ghost sm" data-act="nextMonth">→</button></div>
    <div class="muted small" style="text-align:center">${mss.length} sessions · avg self-rating ${avg(ratings(mss)).toFixed(1) || '–'}</div>
    <div class="cal">${cells}</div>
    <h2>${parse(sel).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
    ${selMk.map(x => `<div class="goal">⭐ <span class="grow">${esc(x.data.label)}</span>${ro ? '' : `<button class="x" data-act="delMark" data-id="${x.id}">✕</button>`}</div>`).join('')}
    ${ro ? '' : `<div class="row wrap"><input id="mark" class="grow" placeholder="Mark an important date (exam, deadline…)"><button class="btn sm" data-act="addMark">Mark</button><button class="btn ghost sm" data-act="toggleBackfill">${S.backfill ? 'Cancel' : '+ Log a past session'}</button></div>`}
    ${!ro && S.backfill ? `<div class="card"><div id="rows">${taskRow()}</div><button class="btn ghost sm" data-act="addRow">+ Add task</button>
      <div class="muted small" style="margin:8px 0">Rate each task:</div><div id="bf-rates"></div>
      <div class="photos" style="margin:10px 0">${photoBox('start', 'Start photo (optional)')}${photoBox('end', 'End photo (optional)')}</div>
      <button class="btn" data-act="saveBackfill">Save to ${esc(sel)}</button></div>` : ''}
    ${selSs.map(s => sessionCard(s, ro)).join('') || (S.backfill ? '' : '<div class="empty">No sessions this day.</div>')}`;
}

function viewCalendar() { return `<h1>Calendar</h1><div class="muted">Your ratings every day. Click a day to see, mark, or backfill it.</div>${calendarHTML(S.me.name, false)}`; }

function viewLeaderboard() {
  const from = S.period === 'week' ? weekStart(today()) : S.period === 'month' ? today().slice(0, 7) + '-01' : '0000';
  const rows = Object.keys(S.db).map(n => ({ n, ...stats(n, from), streak: streak(n) })).sort((a, b) => b.points - a.points || b.avg - a.avg);
  const tab = (k, l) => `<button class="${S.period === k ? 'on' : ''}" data-act="period" data-k="${k}">${l}</button>`;
  return `<h1>🏆 Leaderboard</h1><div class="muted">Points = sum of your self-ratings. Click anyone to see their logs.</div>
    <div class="tabs">${tab('week', 'This week')}${tab('month', 'This month')}${tab('all', 'All time')}</div>
    ${rows.length ? `<table><tr><th>#</th><th>Name</th><th>Points</th><th>Avg</th><th>Sessions</th><th>Streak</th></tr>${rows.map((r, i) => `<tr class="click" data-act="user" data-n="${esc(r.n)}"><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td><span class="row">${avatar(r.n)}${esc(r.n)}</span></td><td><b>${r.points}</b></td><td>${r.avg ? r.avg.toFixed(1) : '–'}</td><td>${r.sessions}</td><td>${r.streak ? '🔥' + r.streak : '–'}</td></tr>`).join('')}</table>` : '<div class="empty">Nobody here yet.</div>'}`;
}

function viewProfile(u) {
  const st = stats(u), ro = u !== S.me.name, by = {};
  sessions(u).forEach(s => s.data.tasks.forEach(t => by[t.cat] = (by[t.cat] || 0) + 1));
  return `<div class="row"><button class="btn ghost sm" data-act="nav" data-v="leaderboard">← Leaderboard</button></div>
    <h1 class="row" style="margin-top:12px">${avatar(u)} ${esc(u)}</h1>
    <div class="stats"><div class="stat"><b>${st.points}</b>points</div><div class="stat"><b>${st.avg ? st.avg.toFixed(1) : '–'}</b>avg rating</div><div class="stat"><b>${st.sessions}</b>sessions</div><div class="stat"><b>🔥 ${streak(u)}</b>day streak</div></div>
    <div class="row wrap">${Object.keys(CATS).map(c => `${pill(c)} <span class="muted small">${by[c] || 0}</span>`).join(' ')}</div>
    ${calendarHTML(u, ro)}`;
}

function render() {
  const app = $('#app');
  if (!S.me) {
    app.innerHTML = `<div class="login"><h1>🕊️ Freed</h1><p class="muted">Set goals. Show up. Rate yourself honestly.</p>
      ${Store.remote ? '' : '<div class="banner">Demo mode: data stays in this browser. Add your Apps Script URL in config.js to sync with Google Sheets.</div>'}
      <input id="l-name" placeholder="Your name" autocomplete="username"><input id="l-pin" type="password" inputmode="numeric" placeholder="PIN (4+ digits)" autocomplete="current-password">
      <button class="btn" data-act="login" style="width:100%;margin-top:6px">Enter</button><p class="muted small">New name? We'll create your account.</p></div>`;
    return;
  }
  const nav = (v, l) => `<button class="${S.view === v ? 'on' : ''}" data-act="nav" data-v="${v}">${l}</button>`;
  const body = S.view === 'today' ? viewToday() : S.view === 'calendar' ? viewCalendar() : S.view === 'leaderboard' ? viewLeaderboard() : viewProfile(S.who || S.me.name);
  app.innerHTML = `<div class="layout"><aside class="side"><div class="me">${avatar(S.me.name)} ${esc(S.me.name)}</div>
    <div class="nav">${nav('today', '✏️ Today')}${nav('calendar', '🗓️ Calendar')}${nav('leaderboard', '🏆 Leaderboard')}${nav('me', '👤 My profile')}</div>
    <div class="foot"><button class="btn ghost sm" data-act="logout">Log out</button></div></aside><main>${body}</main></div>`;
  const bf = $('#bf-rates'); if (bf) syncBackfillRates();
}

/* ---------- actions ---------- */
const readRows = () => [...document.querySelectorAll('#rows .trow')].map(r => ({ text: r.querySelector('.t-text').value.trim(), cat: r.querySelector('.t-cat').value })).filter(t => t.text);
const syncBackfillRates = () => { // one rating row per task row (kept in sync on click/typing)
  const box = $('#bf-rates'), n = document.querySelectorAll('#rows .trow').length;
  if (box.children.length !== n) box.innerHTML = Array.from({ length: n }, (_, i) => `<div class="task"><span class="grow muted small">Task ${i + 1}</span>${rateRow(i)}</div>`).join('');
};
const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nav = v => { S.view = v === 'me' ? 'profile' : v; S.who = v === 'me' ? S.me.name : null; if (v === 'calendar' || v === 'me') S.month = new Date(); S.backfill = false; return refresh().then(render); };

const actions = {
  async login() {
    const name = $('#l-name').value.trim(), pin = $('#l-pin').value;
    if (!/^[\p{L}\p{N} _.-]{2,30}$/u.test(name)) return toast('Name: 2–30 letters/numbers');
    if (!/^\d{4,}$/.test(pin)) return toast('PIN must be 4+ digits');
    try {
      const pinHash = await hashPin(name, pin);
      await Store.auth(name, pinHash);
      S.me = { name, pinHash }; localStorage.setItem('freed_me', JSON.stringify(S.me));
      await refresh(); S.db[name] ||= []; render();
    } catch (e) { toast(e.message); }
  },
  logout() { S.me = null; localStorage.removeItem('freed_me'); render(); },
  nav: a => nav(a.dataset.v),
  user: a => { S.view = 'profile'; S.who = a.dataset.n; S.month = new Date(); return refresh().then(render); },
  period: a => { S.period = a.dataset.k; render(); },
  addRow: () => { $('#rows').insertAdjacentHTML('beforeend', taskRow()); if ($('#bf-rates')) syncBackfillRates(); },
  rmRow: a => { a.closest('.trow').remove(); if ($('#bf-rates')) { $('#bf-rates').innerHTML = ''; syncBackfillRates(); } },
  rate: a => { a.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === a)); },
  async start() {
    const tasks = readRows();
    if (!tasks.length) return toast('Add at least one task');
    if (!pending.start) return toast('Take your start photo first');
    const rec = { id: uid(), type: 'session', date: today(), data: { status: 'active', startedAt: timeNow(), startPhoto: pending.start, tasks } };
    delete pending.start; await persist(rec); toast('Session started'); render();
  },
  async finish() {
    const rec = recs(S.me.name, 'session').find(s => s.data.status === 'active');
    if (!pending.end) return toast('Take your end photo first');
    const rates = [...document.querySelectorAll('.rate')].map(r => +(r.querySelector('.on')?.dataset.v || 0));
    if (rates.includes(0)) return toast('Rate every task');
    rec.data.tasks.forEach((t, i) => t.rating = rates[i]);
    Object.assign(rec.data, { status: 'done', endedAt: timeNow(), endPhoto: pending.end, note: $('#note').value.trim() });
    delete pending.end; await persist(rec); toast('Session saved 🎉'); render();
  },
  selDay: a => { S.sel = a.dataset.d; S.backfill = false; render(); },
  prevMonth: () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); render(); },
  nextMonth: () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); render(); },
  async addMark() {
    const label = $('#mark').value.trim(); if (!label) return;
    await persist({ id: uid(), type: 'date', date: S.sel, data: { label } }); render();
  },
  async delMark(a) { await remove(a.dataset.id); },
  toggleBackfill: () => { S.backfill = !S.backfill; delete pending.start; delete pending.end; render(); },
  async saveBackfill() {
    const tasks = readRows().map(t => t), all = [...document.querySelectorAll('#rows .trow')];
    const rates = [...document.querySelectorAll('#bf-rates .rate')].map(r => +(r.querySelector('.on')?.dataset.v || 0));
    const out = []; all.forEach((r, i) => { const text = r.querySelector('.t-text').value.trim(); if (text) out.push({ text, cat: r.querySelector('.t-cat').value, rating: rates[i] }); });
    if (!out.length) return toast('Add at least one task');
    if (out.some(t => !t.rating)) return toast('Rate every task');
    await persist({ id: uid(), type: 'session', date: S.sel, data: { status: 'done', backfilled: true, startPhoto: pending.start || '', endPhoto: pending.end || '', tasks: out } });
    delete pending.start; delete pending.end; S.backfill = false; toast('Logged'); render();
  },
  async delSession(a) { if (confirm('Delete this session?')) await remove(a.dataset.id); },
  async addGoal(a) {
    const kind = a.dataset.kind, text = $('#g-' + kind).value.trim(); if (!text) return;
    await persist({ id: uid(), type: 'goal', date: kind === 'weekly' ? weekStart(today()) : today(), data: { kind, text, done: false } }); render();
  },
  async toggleGoal(a) { const g = S.db[S.me.name].find(r => r.id === a.dataset.id); g.data.done = a.checked; await persist(g); render(); },
  async delGoal(a) { await remove(a.dataset.id); },
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
    $('#ph-' + id).innerHTML = `<img src="${pending[id]}" alt=""><input type="file" accept="image/*" capture="user" hidden data-photo="${id}">`;
  } catch { toast('Could not read that photo'); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'l-pin') actions.login();
  if (e.key === 'Enter' && e.target.id === 'mark') actions.addMark();
  if (e.key === 'Enter' && e.target.id?.startsWith('g-')) actions.addGoal({ dataset: { kind: e.target.id.slice(2) } });
});

(async function init() {
  try {
    const saved = JSON.parse(localStorage.getItem('freed_me') || 'null');
    if (saved) { await Store.auth(saved.name, saved.pinHash); S.me = saved; await refresh(); S.db[saved.name] ||= []; }
  } catch { localStorage.removeItem('freed_me'); }
  render();
})();
