import { encryptJSON, decryptJSON, saltOf } from './lib/crypto.js';
import { parseICS, hashId } from './lib/ics.js';
import { parseScheduleText } from './lib/schedule-text.js';
import { todayWall, addDays, addMinutes, dow, validDate } from './lib/tz.js';
import { WORKFLOW_PATH, WORKFLOW_YML } from './lib/workflow.js';

/* ---------- config ---------- */
const CONFIG = (() => {
  const q = new URLSearchParams(location.search);
  let owner = 'samahlersmeyer-prog', repo = 'family-calendar';
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    owner = m[1];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg && !seg.includes('.')) repo = seg;
  }
  if (q.get('repo')) [owner, repo] = q.get('repo').split('/');
  return { owner, repo, branch: q.get('branch') || 'main' };
})();
const GH = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
const CAL_FILE = 'data/calendar.enc';
const FEEDS_FILE = 'data/feeds.enc';

const DEFAULT_CALENDARS = [
  { id: 'family', name: 'Family', color: '#2563eb', shared: false },
  { id: 'mad-apple', name: 'Mad Apple', color: '#dc2626', shared: true },
  { id: 'hc-basketball', name: 'Holy Cross Basketball', color: '#7c3aed', shared: true },
  { id: 'max-xc', name: 'Max XC', color: '#059669', shared: true },
  { id: 'theo-baseball', name: 'Theo Baseball', color: '#ea580c', shared: true },
  { id: 'church', name: 'Church & Kids Programs', color: '#ca8a04', shared: true },
];
// Calendars made before sharing existed: everything except "family" is shared.
const isShared = (c) => c.shared ?? c.id !== 'family';
const SHARED_FILE = 'data/shared.enc';
// Google OAuth Client ID for Gmail scanning (not a secret; Settings can override it).
const GOOGLE_CLIENT_ID = '854962669636-0i9dhtsofh30onsch64boiqmj804uhf3.apps.googleusercontent.com';
const googleClientId = () => S.cal?.googleClientId || GOOGLE_CLIENT_ID;
const FEEDS_SHARED_FILE = 'data/feeds-shared.enc';

/* ---------- small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem('fc:' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('fc:' + k) : localStorage.setItem('fc:' + k, v); } catch {} },
};
const b64utf8 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64utf8 = (s) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cal';
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtTime(wall, short = false) {
  if (!wall || !wall.includes('T')) return '';
  let [h, m] = wall.slice(11, 16).split(':').map(Number);
  const ap = h < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM');
  h = h % 12 || 12;
  return short ? `${h}${m ? ':' + String(m).padStart(2, '0') : ''}${ap}` : `${h}:${String(m).padStart(2, '0')}${ap}`;
}
function fmtDay(day, long = false) {
  const [y, m, d] = day.split('-').map(Number);
  return `${long ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow(day)] : DOW[dow(day)]}, ${MONTHS[m - 1].slice(0, long ? 9 : 3)} ${d}${long && y !== +todayWall().slice(0, 4) ? ', ' + y : ''}`;
}

/* ---------- state ---------- */
const S = {
  pass: null,
  token: store.get('token'),
  cal: null,
  calSalt: null,
  feeds: { events: [], status: {} },
  hidden: new Set(JSON.parse(store.get('hidden') || '[]')),
  view: store.get('view') || (innerWidth < 760 ? 'list' : 'month'),
  month: todayWall().slice(0, 7),
  day: todayWall(),
  loadedAt: 0,
};
const isEditor = () => !!S.token && !S.relative;
const app = $('#app');

/* ---------- GitHub ---------- */
const ghHeaders = () => ({ Accept: 'application/vnd.github+json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) });

async function readFile(path, { api = !!S.token } = {}) {
  if (api) {
    const r = await fetch(`${GH}/contents/${path}?ref=${CONFIG.branch}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
    if (r.status === 404) return { text: null };
    if (r.status === 401) throw new Error('Your GitHub token was rejected. Update it in Settings.');
    if (!r.ok) throw new Error('GitHub error ' + r.status);
    const j = await r.json();
    if (j.content) return { text: unb64utf8(j.content), sha: j.sha };
    const r2 = await fetch(j.download_url, { cache: 'no-store' });
    return { text: await r2.text(), sha: j.sha };
  }
  const r = await fetch(`https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (r.status === 404) return { text: null };
  if (!r.ok) throw new Error('Could not load the calendar (' + r.status + ')');
  return { text: await r.text() };
}

async function writeFile(path, text, sha, message) {
  const r = await fetch(`${GH}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64utf8(text), branch: CONFIG.branch, ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(j.message || 'GitHub error ' + r.status);
    e.status = r.status;
    throw e;
  }
  return (await r.json()).content.sha;
}

/** Re-read the latest calendar, apply a change, and save — so two editors never overwrite each other. */
async function saveCal(mutate, message) {
  if (!isEditor()) throw new Error('Add your GitHub token in Settings to make changes.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await readFile(CAL_FILE, { api: true });
    const data = cur.text ? await decryptJSON(cur.text, S.pass) : emptyCal();
    mutate(data);
    data.updated = new Date().toISOString();
    try {
      const text = await encryptJSON(data, S.pass, cur.text ? saltOf(cur.text) : S.calSalt);
      await writeFile(CAL_FILE, text, cur.sha, message);
      S.cal = data;
      S.calSalt = saltOf(text);
      renderMain();
      return data;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw new Error('Someone else is saving right now — try again.');
}

const emptyCal = () => ({ v: 2, title: 'Ahlersmeyer Family Calendar', calendars: DEFAULT_CALENDARS.map((c) => ({ ...c })), events: [], updated: new Date().toISOString() });

async function loadFeeds() {
  try {
    const f = await readFile(S.relative ? FEEDS_SHARED_FILE : FEEDS_FILE, { api: false });
    S.feeds = f.text ? await decryptJSON(f.text, S.pass) : { events: [], status: {} };
  } catch { S.feeds = { events: [], status: {} }; }
}

/* Add the Church calendar and sharing flags to calendars made before they existed. */
async function migrate() {
  if (S.cal.v >= 2) return;
  try {
    await saveCal((d) => {
      for (const c of d.calendars) c.shared = isShared(c);
      if (!d.calendars.some((c) => c.id === 'church')) d.calendars.push({ ...DEFAULT_CALENDARS.find((c) => c.id === 'church') });
      d.v = 2;
    }, 'Add sharing settings');
  } catch {}
}

/* ---------- boot / lock / setup ---------- */
async function boot() {
  const pass = store.get('pass');
  if (pass) return unlock(pass, true);
  try {
    const f = await readFile(CAL_FILE);
    f.text ? renderLock() : renderSetup();
  } catch (e) { renderLock(e.message); }
}

async function unlock(pass, remember) {
  app.innerHTML = `<div class="center muted">Loading…</div>`;
  let file;
  try { file = await readFile(CAL_FILE); } catch (e) { return renderLock(e.message); }
  if (!file.text) return renderSetup();
  S.relative = false;
  try {
    S.cal = await decryptJSON(file.text, pass);
    S.calSalt = saltOf(file.text);
  } catch {
    // Not the family passcode — maybe the extended-family one.
    let shared = null;
    try { const sf = await readFile(SHARED_FILE, { api: false }); if (sf.text) shared = await decryptJSON(sf.text, pass); } catch {}
    if (!shared) {
      store.set('pass', null);
      return renderLock('That passcode didn’t work.');
    }
    S.cal = shared;
    S.relative = true;
  }
  S.pass = pass;
  if (remember) store.set('pass', pass);
  await loadFeeds();
  if (isEditor()) migrate();
  S.loadedAt = Date.now();
  renderMain();
}

function renderLock(error = '') {
  app.innerHTML = `
  <div class="center"><form class="card" id="lock">
    <h1>Family Calendar</h1>
    <p class="help">Enter the family passcode to see the calendar.</p>
    <input class="in" id="pass" type="password" autocomplete="current-password" placeholder="Passcode" autofocus>
    ${error ? `<p class="bad help">${esc(error)}</p>` : ''}
    <label class="check"><input type="checkbox" id="rem" checked> Remember on this device</label>
    <div class="actions"><button class="btn primary">Open calendar</button></div>
  </form></div>`;
  $('#lock').onsubmit = (e) => {
    e.preventDefault();
    const p = $('#pass').value.trim();
    if (p) unlock(p, $('#rem').checked);
  };
}

function renderSetup() {
  app.innerHTML = `
  <div class="center"><form class="card" id="setup">
    <h1>Set up the calendar</h1>
    <p class="help">First-time setup for <code>${esc(CONFIG.owner)}/${esc(CONFIG.repo)}</code>. Pick a passcode the family will use to open the calendar — everything is encrypted with it.</p>
    <label class="f">Family passcode</label>
    <input class="in" id="p1" type="password" autocomplete="new-password" minlength="6" required>
    <label class="f">Type it again</label>
    <input class="in" id="p2" type="password" autocomplete="new-password" required>
    <label class="f">GitHub token (editors only)</label>
    <input class="in" id="tok" type="password" value="${esc(S.token || '')}" placeholder="github_pat_…" required>
    <p class="help">Make one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained tokens</a>: only this repository, with <b>Contents</b>, <b>Actions</b>, and <b>Workflows</b> set to Read and write.</p>
    <p class="bad help" id="err"></p>
    <div class="actions"><button class="btn primary">Create calendar</button></div>
  </form></div>`;
  $('#setup').onsubmit = async (e) => {
    e.preventDefault();
    const p1 = $('#p1').value.trim(), p2 = $('#p2').value.trim(), tok = $('#tok').value.trim();
    if (p1.length < 6) return ($('#err').textContent = 'Use at least 6 characters.');
    if (p1 !== p2) return ($('#err').textContent = 'The passcodes don’t match.');
    const btn = $('#setup button');
    btn.disabled = true; btn.textContent = 'Setting up…';
    S.token = tok; store.set('token', tok);
    S.pass = p1;
    try {
      const data = emptyCal();
      const text = await encryptJSON(data, p1);
      await writeFile(CAL_FILE, text, null, 'Create family calendar');
      S.cal = data; S.calSalt = saltOf(text);
      let wfOk = true;
      try {
        const cur = await readFile(WORKFLOW_PATH, { api: true });
        if (cur.text !== WORKFLOW_YML) await writeFile(WORKFLOW_PATH, WORKFLOW_YML, cur.sha, 'Add team feed sync');
      } catch { wfOk = false; }
      store.set('pass', p1);
      renderSetupDone(wfOk);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Create calendar';
      $('#err').textContent = err.message;
    }
  };
}

function renderSetupDone(wfOk) {
  app.innerHTML = `
  <div class="center"><div class="card">
    <h1>Calendar created 🎉</h1>
    <p class="help">One more step so team schedules (GameChanger, SportsYou) can sync automatically:</p>
    <ol class="steps">
      ${wfOk ? '' : `<li>Your token couldn’t add the sync workflow. Give it <b>Workflows: Read and write</b>, then reopen Settings → Sync now.</li>`}
      <li>Open <a href="https://github.com/${esc(CONFIG.owner)}/${esc(CONFIG.repo)}/settings/secrets/actions/new" target="_blank" rel="noopener">repository secrets</a>.</li>
      <li>Name: <code>CAL_PASSCODE</code></li>
      <li>Secret: the family passcode you just chose.</li>
    </ol>
    <div class="actions"><button class="btn primary" id="go">Open the calendar</button></div>
  </div></div>`;
  $('#go').onclick = () => renderMain();
}

/* ---------- events ---------- */
const calById = (id) => S.cal.calendars.find((c) => c.id === id) || { id, name: 'Other', color: '#94a3b8' };

function allEvents() {
  const seen = new Set();
  const out = [];
  for (const e of [...S.cal.events, ...(S.feeds.events || [])]) {
    if (seen.has(e.id) || S.hidden.has(e.cal)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}
const findEvent = (id) => S.cal.events.find((e) => e.id === id) || (S.feeds.events || []).find((e) => e.id === id);

function indexByDay(from, to) {
  const idx = {};
  for (const e of allEvents()) {
    const sd = e.start.slice(0, 10);
    if (e.allDay) {
      const end = e.end && e.end > e.start ? e.end.slice(0, 10) : addDays(sd, 1);
      if (end <= from || sd > to) continue;
      let d = sd < from ? from : sd;
      for (let i = 0; d < end && d <= to && i < 62; i++, d = addDays(d, 1)) (idx[d] ||= []).push(e);
    } else if (sd >= from && sd <= to) (idx[sd] ||= []).push(e);
  }
  for (const k in idx) idx[k].sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return idx;
}

function evRow(e) {
  const c = calById(e.cal);
  const t = e.allDay ? 'All day' : fmtTime(e.start);
  const end = !e.allDay && e.end && e.end.slice(0, 10) === e.start.slice(0, 10) ? fmtTime(e.end) : '';
  const sub = [e.location, c.name].filter(Boolean).join(' · ');
  return `<button class="ev" data-ev="${esc(e.id)}"><span class="bar" style="background:${esc(c.color)}"></span>
    <span class="t">${t}${end ? `<small>${end}</small>` : ''}</span>
    <span class="b"><b>${esc(e.title)}</b><small>${esc(sub)}</small></span></button>`;
}

/* ---------- main screen ---------- */
function renderMain() {
  app.innerHTML = `
  <header class="top">
    <div class="row1">
      <div class="brand">${esc(S.cal.title || 'Family Calendar')}</div>
      <button class="btn icon" id="btnSettings" aria-label="Settings">⚙︎</button>
    </div>
    <div class="row2">
      <div class="seg"><button data-view="list" class="${S.view === 'list' ? 'on' : ''}">List</button><button data-view="month" class="${S.view === 'month' ? 'on' : ''}">Month</button></div>
      <span class="spacer"></span>
      ${isEditor() ? `<button class="btn" id="btnEmail">✉︎ Email</button><button class="btn" id="btnImport">Import</button>` : ''}
    </div>
  </header>
  <nav class="chips">${S.cal.calendars.map((c) => `<button class="chip ${S.hidden.has(c.id) ? 'off' : ''}" data-cal="${esc(c.id)}"><i style="background:${esc(c.color)}"></i>${esc(c.name)}</button>`).join('')}</nav>
  <main id="view"></main>
  ${isEditor() ? `<button class="fab" id="btnAdd" aria-label="Add event">+</button>` : ''}`;
  $$('[data-view]').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; store.set('view', S.view); renderMain(); }));
  $$('[data-cal]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.cal;
    S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
    store.set('hidden', JSON.stringify([...S.hidden]));
    renderMain();
  }));
  $('#btnSettings').onclick = openSettings;
  if (isEditor()) {
    $('#btnImport').onclick = () => openImport();
    $('#btnEmail').onclick = () => openImport(null, 'email');
    $('#btnAdd').onclick = () => openEdit(null, S.view === 'month' ? S.day : todayWall());
  }
  S.view === 'month' ? renderMonth() : renderList();
}

function bindEvents(root) {
  $$('[data-ev]', root).forEach((b) => (b.onclick = () => openDetail(b.dataset.ev)));
}

function renderList() {
  const view = $('#view');
  const from = todayWall(), to = addDays(from, 240);
  const idx = indexByDay(from, to);
  const days = Object.keys(idx).sort().slice(0, 90);
  if (!days.length) {
    view.innerHTML = `<div class="empty"><p><b>Nothing coming up.</b></p><p>${isEditor() ? 'Tap + to add an event, Import to drop in a schedule, or add a team feed in Settings.' : 'Check back soon.'}</p></div>`;
    return;
  }
  const tmw = addDays(from, 1);
  view.innerHTML = days.map((d) => `
    <section class="day"><h3>${fmtDay(d)} ${d === from ? '<span class="rel">Today</span>' : d === tmw ? '<span class="rel">Tomorrow</span>' : ''}</h3>
    ${idx[d].map(evRow).join('')}</section>`).join('');
  bindEvents(view);
}

function renderMonth() {
  const view = $('#view');
  const [y, m] = S.month.split('-').map(Number);
  const first = `${S.month}-01`;
  const start = addDays(first, -dow(first));
  let days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  if (days[35].slice(0, 7) !== S.month) days = days.slice(0, 35);
  const idx = indexByDay(days[0], days[days.length - 1]);
  const today = todayWall();
  view.innerHTML = `
    <div class="monthbar">
      <button class="btn icon" id="prev" aria-label="Previous month">‹</button>
      <h2>${MONTHS[m - 1]} ${y}</h2>
      <button class="btn" id="today">Today</button>
      <button class="btn icon" id="next" aria-label="Next month">›</button>
    </div>
    <div class="grid dow">${DOW.map((d) => `<div>${d[0]}</div>`).join('')}</div>
    <div class="grid">${days.map((d) => {
      const evs = idx[d] || [];
      return `<button class="cell ${d.slice(0, 7) !== S.month ? 'dim' : ''} ${d === today ? 'today' : ''} ${d === S.day ? 'sel' : ''}" data-day="${d}">
        <span class="num">${+d.slice(8)}</span>
        ${evs.slice(0, 3).map((e) => `<span class="pill" style="--c:${esc(calById(e.cal).color)}">${e.allDay ? '' : `<span class="pt">${fmtTime(e.start, true)} </span>`}${esc(e.title)}</span>`).join('')}
        ${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ''}</button>`;
    }).join('')}</div>
    <section class="day" id="daylist"></section>`;
  const shift = (n) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    S.month = d.toISOString().slice(0, 7);
    S.day = S.month === today.slice(0, 7) ? today : `${S.month}-01`;
    renderMonth();
  };
  $('#prev').onclick = () => shift(-1);
  $('#next').onclick = () => shift(1);
  $('#today').onclick = () => { S.month = today.slice(0, 7); S.day = today; renderMonth(); };
  $$('[data-day]').forEach((b) => (b.onclick = () => {
    S.day = b.dataset.day;
    if (S.day.slice(0, 7) !== S.month) S.month = S.day.slice(0, 7);
    renderMonth();
    $('#daylist').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
  const evs = idx[S.day] || [];
  $('#daylist').innerHTML = `<h3>${fmtDay(S.day)}</h3>${evs.length ? evs.map(evRow).join('') : '<p class="muted">No events.</p>'}`;
  bindEvents($('#daylist'));
}

/* ---------- modal ---------- */
function openModal(html) {
  $('#sheet').innerHTML = html;
  $('#modal').classList.remove('hidden');
  return $('#sheet');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openDetail(id) {
  const e = findEvent(id);
  if (!e) return;
  const c = calById(e.cal);
  const day = e.start.slice(0, 10);
  let when = fmtDay(day, true);
  if (e.allDay) {
    const last = e.end ? addDays(e.end.slice(0, 10), -1) : day;
    if (last > day) when += ` – ${fmtDay(last, true)}`;
  } else when += ` · ${fmtTime(e.start)}${e.end ? ' – ' + fmtTime(e.end) : ''}`;
  const fromFeed = e.source === 'feed';
  const sh = openModal(`
    <div class="head"><div><h2>${esc(e.title)}</h2><span class="chip"><i style="background:${esc(c.color)}"></i>${esc(c.name)}</span></div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="meta">
      <div>🗓 ${esc(when)}</div>
      ${e.location ? `<div>📍 <a href="https://maps.apple.com/?q=${encodeURIComponent(e.location)}" target="_blank" rel="noopener">${esc(e.location)}</a></div>` : ''}
      ${e.notes ? `<div class="notes">${esc(e.notes)}</div>` : ''}
      ${fromFeed ? `<div class="help">Synced from the team’s calendar — changes come from the team app.</div>` : ''}
    </div>
    ${isEditor() && !fromFeed ? `<div class="actions"><button class="btn" id="edit">Edit</button><button class="btn danger" id="del">Delete</button></div>` : ''}`);
  $('[data-close]', sh).onclick = closeModal;
  if (isEditor() && !fromFeed) {
    $('#edit').onclick = () => openEdit(e);
    $('#del').onclick = async () => {
      if (!confirm(`Delete “${e.title}”?`)) return;
      try { await saveCal((d) => { d.events = d.events.filter((x) => x.id !== e.id); }, `Delete: ${e.title}`); closeModal(); toast('Deleted'); }
      catch (err) { toast(err.message, 5000); }
    };
  }
}

function calOptions(sel) {
  return S.cal.calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function openEdit(e, day) {
  const isNew = !e;
  e ||= { cal: store.get('lastCal') || 'family', title: '', start: `${day}T18:00`, end: `${day}T19:00`, allDay: false, location: '', notes: '' };
  const d = e.start.slice(0, 10);
  const lastDay = e.allDay ? addDays((e.end || addDays(d, 1)).slice(0, 10), -1) : d;
  const sh = openModal(`
    <div class="head"><div><h2>${isNew ? 'New event' : 'Edit event'}</h2></div><button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <form id="ef">
      <label class="f">What</label><input class="in" name="title" value="${esc(e.title)}" required placeholder="e.g. Theo practice">
      <label class="f">Calendar</label><select class="in" name="cal">${calOptions(e.cal)}</select>
      <div class="two"><div><label class="f">Date</label><input class="in" type="date" name="date" value="${d}" required></div>
        <div class="alld ${e.allDay ? '' : 'hidden'}"><label class="f">Through</label><input class="in" type="date" name="last" value="${lastDay}"></div></div>
      <label class="check"><input type="checkbox" name="allDay" ${e.allDay ? 'checked' : ''}> All day</label>
      <div class="two timed ${e.allDay ? 'hidden' : ''}"><div><label class="f">Starts</label><input class="in" type="time" name="st" value="${e.allDay ? '18:00' : e.start.slice(11, 16)}"></div>
        <div><label class="f">Ends</label><input class="in" type="time" name="et" value="${!e.allDay && e.end ? e.end.slice(11, 16) : ''}"></div></div>
      <label class="f">Where</label><input class="in" name="location" value="${esc(e.location)}">
      <label class="f">Notes</label><textarea class="in" name="notes" style="min-height:80px">${esc(e.notes)}</textarea>
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>`);
  $('[data-close]', sh).onclick = closeModal;
  const f = $('#ef');
  f.allDay.onchange = () => { $('.timed', f).classList.toggle('hidden', f.allDay.checked); $('.alld', f).classList.toggle('hidden', !f.allDay.checked); };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const date = f.date.value;
    const allDay = f.allDay.checked;
    let start, end;
    if (allDay) {
      start = date;
      end = addDays(f.last.value && f.last.value >= date ? f.last.value : date, 1);
    } else {
      start = `${date}T${f.st.value || '00:00'}`;
      end = f.et.value ? `${date}T${f.et.value}` : addMinutes(start, 60);
      if (end <= start) end = addDays(end, 1);
    }
    const out = { ...e, id: e.id || newId(), cal: f.cal.value, title: f.title.value.trim(), allDay, start, end, location: f.location.value.trim(), notes: f.notes.value.trim(), source: e.source || 'manual' };
    store.set('lastCal', out.cal);
    const btn = $('button.primary', f);
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await saveCal((d) => {
        const i = d.events.findIndex((x) => x.id === out.id);
        i >= 0 ? (d.events[i] = out) : d.events.push(out);
      }, `${isNew ? 'Add' : 'Update'}: ${out.title}`);
      closeModal(); toast('Saved');
    } catch (err) { btn.disabled = false; btn.textContent = 'Save'; toast(err.message, 5000); }
  };
}

/* ---------- import (ICS / PDF / pasted text) ---------- */
let pdfjsReady;
function loadPdfJs() {
  return (pdfjsReady ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; rej(new Error('Couldn’t load the PDF reader. Check your connection.')); };
    document.head.appendChild(s);
  }));
}

async function pdfText(file) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) <= 3);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) out.push(r.items.sort((a, b) => a.x - b.x).map((i) => i.s).join('  '));
  }
  return out.join('\n');
}

function guessCal(name) {
  const n = name.toLowerCase();
  const hit = S.cal.calendars.find((c) => n.includes(c.name.toLowerCase()) || c.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && n.includes(w)));
  return hit?.id || store.get('lastCal') || 'family';
}

function openImport(files, tab = 'file') {
  const sh = openModal(`
    <div class="head"><div><h2>Import events</h2><p class="help">Calendar files (.ics), schedule PDFs, or text copied from an email or team website.</p></div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="seg"><button data-tab="file">File</button><button data-tab="text">Paste text</button><button data-tab="email">Email</button></div>
    <div data-pane="file"><label class="dropzone"><input type="file" id="files" accept=".ics,.ical,.ifb,.pdf,text/calendar,application/pdf" multiple hidden>
      <b>Tap to choose files</b><br>or drag .ics / PDF files anywhere on the page</label></div>
    <div data-pane="text" class="hidden"><textarea class="in" id="paste" placeholder="Paste a schedule — one game or practice per line works best"></textarea>
      <div class="actions"><button class="btn primary" id="findText">Find events</button></div></div>
    <div data-pane="email" class="hidden">${emailPane()}</div>
    <div id="review" class="review"></div>`);
  $('[data-close]', sh).onclick = closeModal;
  const showTab = (t) => {
    $$('[data-tab]', sh).forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
    $$('[data-pane]', sh).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t));
    $('#review').innerHTML = '';
    if (t === 'email' && googleClientId()) loadGIS().catch(() => {});
  };
  $$('[data-tab]', sh).forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  showTab(tab);
  if ($('#scanBtn', sh)) $('#scanBtn', sh).onclick = startEmailScan;
  $('#files', sh).onchange = (e) => handleFiles([...e.target.files]);
  $('#findText', sh).onclick = () => {
    const rows = parseScheduleText($('#paste').value);
    renderReview({ textRows: rows, label: 'Pasted text', cal: store.get('lastCal') || 'family' });
  };
  if (files?.length) handleFiles(files);
}

async function handleFiles(files) {
  const review = $('#review');
  review.innerHTML = `<p class="muted">Reading ${files.length > 1 ? files.length + ' files' : esc(files[0].name)}…</p>`;
  const icsEvents = [], textRows = [], notes = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    try {
      if (/\.(ics|ical|ifb)$/.test(name) || f.type === 'text/calendar') {
        icsEvents.push(...parseICS(await f.text(), { calId: 'tmp', source: 'ics', pastDays: 1 }));
      } else if (name.endsWith('.pdf') || f.type === 'application/pdf') {
        const text = await pdfText(f);
        if (text.replace(/\s/g, '').length < 20) { notes.push(`${f.name} looks like a scanned image — send it to Claude in chat and it can read it for you.`); continue; }
        const rows = parseScheduleText(text);
        if (!rows.length) notes.push(`No dates found in ${f.name}. Try “Paste text”, or send it to Claude.`);
        textRows.push(...rows);
      } else if (/^image\//.test(f.type)) {
        notes.push(`${f.name} is a picture — send screenshots to Claude in chat and it’ll add the events.`);
      } else {
        notes.push(`${f.name}: only .ics and PDF files can be imported here.`);
      }
    } catch (e) { notes.push(`${f.name}: ${e.message}`); }
  }
  renderReview({ icsEvents, textRows, notes, label: files.map((f) => f.name).join(', '), cal: guessCal(files.map((f) => f.name).join(' ')) });
}

function renderReview({ icsEvents = [], textRows = [], notes = [], label, cal }) {
  const review = $('#review');
  const total = icsEvents.length + textRows.length;
  review.innerHTML = `
    ${notes.map((n) => `<p class="help bad">${esc(n)}</p>`).join('')}
    ${total ? `
    <h4>Found ${total} event${total === 1 ? '' : 's'}</h4>
    <label class="f">Add to calendar</label><select class="in" id="rcal">${calOptions(cal)}</select>
    <p class="help">Uncheck anything you don’t want, and fix titles or times before adding.</p>
    <div id="rows">
      ${icsEvents.map((e, i) => `<label class="rrow ics"><input type="checkbox" data-i="${i}" data-k="ics" checked>
        <span><b>${esc(e.title)}</b><br><span class="muted">${fmtDay(e.start.slice(0, 10))}${e.allDay ? '' : ' · ' + fmtTime(e.start)}${e.location ? ' · ' + esc(e.location) : ''}</span></span></label>`).join('')}
      ${textRows.map((r, i) => `<div class="rrow"><input type="checkbox" data-i="${i}" data-k="txt" ${r.title ? 'checked' : ''}>
        <div class="fields">
          <input class="in full" data-f="title" value="${esc(r.title)}" placeholder="Title">
          <input class="in" type="date" data-f="date" value="${r.date}">
          <input class="in" type="time" data-f="time" value="${r.time || ''}">
          <input class="in full" data-f="location" value="${esc(r.location || '')}" placeholder="Where (optional)">
        </div><div class="src">From: “${esc(r.line.slice(0, 120))}”</div></div>`).join('')}
    </div>
    <div class="actions"><button class="btn primary" id="addAll">Add events</button></div>` : notes.length ? '' : '<p class="muted">No events found.</p>'}`;
  if (!total) return;
  const btn = $('#addAll');
  const count = () => { const n = $$('#rows input[type=checkbox]:checked').length; btn.textContent = `Add ${n} event${n === 1 ? '' : 's'}`; btn.disabled = !n; };
  $$('#rows input[type=checkbox]').forEach((c) => (c.onchange = count));
  count();
  btn.onclick = async () => {
    const calId = $('#rcal').value;
    store.set('lastCal', calId);
    const out = [];
    for (const c of $$('#rows input[type=checkbox]:checked')) {
      const i = +c.dataset.i;
      if (c.dataset.k === 'ics') {
        const e = icsEvents[i];
        out.push({ ...e, cal: calId, id: hashId(calId + '|' + e.id) });
      } else {
        const row = c.closest('.rrow');
        const title = $('[data-f=title]', row).value.trim() || 'Event';
        const date = $('[data-f=date]', row).value;
        const time = $('[data-f=time]', row).value;
        if (!validDate(date)) continue;
        const r = textRows[i];
        const start = time ? `${date}T${time}` : date;
        let end = !time ? addDays(date, 1) : r.endTime && r.time === time ? `${date}T${r.endTime}` : addMinutes(start, 90);
        if (end <= start) end = addMinutes(start, 90);
        const location = $('[data-f=location]', row).value.trim();
        out.push({ id: hashId(calId + '|' + start + '|' + title), cal: calId, title, start, end, allDay: !time, location, notes: '', source: 'import' });
      }
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let added = 0;
      await saveCal((d) => {
        const ids = new Set(d.events.map((e) => e.id));
        for (const e of out) if (!ids.has(e.id)) { d.events.push(e); added++; }
      }, `Import ${out.length} events from ${label}`.slice(0, 100));
      closeModal();
      toast(added === out.length ? `Added ${added} events` : `Added ${added} (${out.length - added} were already on the calendar)`);
    } catch (err) { count(); toast(err.message, 5000); }
  };
}

/* ---------- email scanning (Gmail, read-only, runs in the browser) ---------- */
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAIL_QUERY = '-category:promotions -category:social (filename:ics OR invite OR invitation OR schedule OR practice OR game OR games OR tournament OR rehearsal OR recital OR program OR concert OR party OR appointment OR "save the date" OR reminder OR choir OR sing OR singing OR "field trip" OR conference OR meet OR tryouts OR banquet OR birthday OR camp OR clinic)';

let gisReady;
function loadGIS() {
  return (gisReady ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => res(window.google);
    s.onerror = () => { gisReady = null; rej(new Error('Couldn’t reach Google sign-in.')); };
    document.head.appendChild(s);
  }));
}

function emailPane() {
  if (!googleClientId()) return `<p class="help" style="margin-top:14px">Email scanning needs a one-time Google setup. Open ⚙︎ Settings → <b>Email scanning</b>.</p>`;
  const last = +store.get('lastScan') || 0;
  const since = last ? Math.min(60, Math.max(1, Math.ceil((Date.now() - last) / 864e5) + 1)) : 0;
  return `<p class="help" style="margin-top:14px">Looks through <b>your</b> Gmail for invites, schedules and events you haven’t reviewed yet. Nothing is added until you check it.</p>
    <label class="f">Look back</label>
    <select class="in" id="days">
      ${since ? `<option value="${since}">Since my last scan (${since} day${since === 1 ? '' : 's'})</option>` : ''}
      ${[7, 14, 30, 60].map((d) => `<option value="${d}" ${!since && d === 14 ? 'selected' : ''}>Last ${d} days</option>`).join('')}
    </select>
    <div class="actions"><button class="btn primary" id="scanBtn">Sign in with Google &amp; scan</button></div>`;
}

function startEmailScan() {
  // Must run straight from the tap so the Google sign-in window isn't blocked.
  const g = window.google?.accounts?.oauth2;
  if (!g) { loadGIS().catch((e) => toast(e.message, 5000)); return toast('Loading Google sign-in — tap again in a second'); }
  const client = g.initTokenClient({
    client_id: googleClientId(),
    scope: GMAIL_SCOPE,
    callback: (r) => (r.error ? toast(r.error_description || 'Google sign-in failed', 5000) : runEmailScan(r.access_token)),
    error_callback: (e) => toast(e.type === 'popup_closed' ? 'Sign-in was closed' : 'Google sign-in failed — check the Client ID setup', 5000),
  });
  client.requestAccessToken();
}

async function gm(path, token) {
  const r = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) throw new Error('Google sign-in expired — scan again.');
  if (r.status === 403) throw new Error('Gmail said no (403). Make sure the Gmail API is enabled and you’re a test user.');
  if (!r.ok) throw new Error('Gmail error ' + r.status);
  return r.json();
}
const b64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
const walkParts = (p, out = []) => { p.parts ? p.parts.forEach((x) => walkParts(x, out)) : out.push(p); return out; };
function htmlToText(h) {
  const d = new DOMParser().parseFromString(h.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/td)\b[^>]*>/gi, '\n$&'), 'text/html');
  d.querySelectorAll('style,script,head').forEach((n) => n.remove());
  return d.body?.textContent || '';
}
function trimBody(t) {
  const out = [];
  for (let l of t.replace(/\r/g, '').split('\n')) {
    if (/^\s*(On .{5,160} wrote:|-{2,}\s*Original Message)/i.test(l)) break; // quoted replies
    if (/^\s*>/.test(l) || /^\s*(Sent from my|Unsubscribe|To unsubscribe)/i.test(l)) continue;
    l = l.trim();
    if (!l) continue;
    out.push(...(l.length > 160 ? l.split(/(?<=[.!?])\s+/) : [l]));
    if (out.length > 150) break;
  }
  return out.join('\n');
}

const CAL_HINTS = [
  [/gamechanger|mad apple/, 'mad-apple'],
  [/basketball|hoops/, 'hc-basketball'],
  [/cross country|\bxc\b|nationals/, 'max-xc'],
  [/baseball|little league|travel ball/, 'theo-baseball'],
  [/church|choir|\bsing|sunday school|christmas program|chapel|worship|\bvbs\b|youth group/, 'church'],
];
function guessCalText(t) {
  t = t.toLowerCase();
  for (const [re, id] of CAL_HINTS) if (re.test(t) && S.cal.calendars.some((c) => c.id === id)) return id;
  const hit = S.cal.calendars.find((c) => c.id !== 'family' && t.includes(c.name.toLowerCase()));
  return hit?.id || 'family';
}

async function extractMail(m, token) {
  const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  const subject = (h.subject || '(no subject)').trim();
  const from = (h.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  const items = [];
  let plain = '', html = '';
  for (const p of walkParts(m.payload || {})) {
    const mt = (p.mimeType || '').toLowerCase(), fn = (p.filename || '').toLowerCase();
    if (mt === 'text/calendar' || fn.endsWith('.ics')) {
      let data = p.body?.data;
      if (!data && p.body?.attachmentId) data = (await gm(`/messages/${m.id}/attachments/${p.body.attachmentId}`, token)).data;
      if (data) for (const ev of parseICS(b64url(data), { calId: 'tmp', source: 'email', pastDays: 0 })) items.push({ kind: 'ics', ev });
    } else if (!p.filename && p.body?.data) {
      if (mt === 'text/plain') plain += b64url(p.body.data) + '\n';
      else if (mt === 'text/html') html += b64url(p.body.data) + '\n';
    }
  }
  const guess = guessCalText(`${subject} ${from} ${(plain || htmlToText(html)).slice(0, 800)}`);
  if (!items.length) {
    const today = todayWall(), keys = new Set();
    const cleanSubject = subject.replace(/^((re|fwd?|fw):\s*)+/i, '').slice(0, 70);
    for (const r of parseScheduleText(cleanSubject + '\n' + trimBody(plain || htmlToText(html)))) {
      if (r.date < today || r.date > addDays(today, 400)) continue;
      const k = r.date + '|' + r.time;
      if (keys.has(k)) continue;
      keys.add(k);
      const words = (r.title || '').split(/\s+/).length;
      const title = r.title && r.title.length >= 3 && words <= 7 ? r.title : cleanSubject;
      items.push({ kind: 'txt', row: { ...r, title } });
      if (items.length >= 8) break;
    }
  }
  return { id: m.id, subject, from, items, guess };
}

async function runEmailScan(token) {
  const review = $('#review');
  const days = +($('#days')?.value || 14);
  review.innerHTML = `<p class="muted">Searching your email…</p>`;
  try {
    const seen = new Set(JSON.parse(store.get('seenMail') || '[]'));
    const list = await gm(`/messages?maxResults=80&q=${encodeURIComponent(`newer_than:${days}d ${MAIL_QUERY}`)}`, token);
    const ids = (list.messages || []).map((m) => m.id).filter((id) => !seen.has(id));
    const found = [];
    for (let i = 0; i < ids.length; i++) {
      review.innerHTML = `<p class="muted">Reading email ${i + 1} of ${ids.length}…</p>`;
      const mail = await extractMail(await gm(`/messages/${ids[i]}?format=full`, token), token);
      if (mail.items.length) found.push(mail);
    }
    store.set('lastScan', String(Date.now()));
    renderEmailReview(found, ids);
  } catch (e) {
    review.innerHTML = `<p class="bad help">${esc(e.message)}</p>`;
  }
}

function markSeen(ids) {
  const seen = JSON.parse(store.get('seenMail') || '[]');
  store.set('seenMail', JSON.stringify([...seen, ...ids].slice(-1500)));
}

function renderEmailReview(found, ids) {
  const review = $('#review');
  const existing = new Set(allEvents().map((e) => e.title.toLowerCase() + '|' + e.start));
  if (!found.length) {
    markSeen(ids);
    review.innerHTML = `<p class="muted">${ids.length ? `Checked ${ids.length} new email${ids.length === 1 ? '' : 's'} — no upcoming events found.` : 'No new emails to check.'}</p>`;
    return;
  }
  const rowOf = (it) => it.kind === 'ics'
    ? { title: it.ev.title, date: it.ev.start.slice(0, 10), time: it.ev.allDay ? '' : it.ev.start.slice(11, 16), location: it.ev.location }
    : { title: it.row.title, date: it.row.date, time: it.row.time || '', location: it.row.location || '' };
  review.innerHTML = `
    <h4>Events in ${found.length} email${found.length === 1 ? '' : 's'}</h4>
    <p class="help">Calendar invites are pre-checked. For the rest, check what’s real and fix anything that looks off — each row can go to a different calendar.</p>
    <div id="rows">${found.map((f, mi) => `
      <div class="mail"><div class="mailhead"><b>${esc(f.subject)}</b><small>${esc(f.from)}</small></div>
      ${f.items.map((it, ii) => {
        const r = rowOf(it);
        const dupe = existing.has(r.title.toLowerCase() + '|' + (r.time ? `${r.date}T${r.time}` : r.date));
        return `<div class="rrow" data-m="${mi}" data-i="${ii}"><input type="checkbox" ${it.kind === 'ics' && !dupe ? 'checked' : ''}>
          <div class="fields">
            <input class="in full" data-f="title" value="${esc(r.title)}" placeholder="Title">
            <input class="in" type="date" data-f="date" value="${r.date}">
            <input class="in" type="time" data-f="time" value="${r.time}">
            <input class="in full" data-f="location" value="${esc(r.location)}" placeholder="Where (optional)">
            <select class="in full" data-f="cal">${calOptions(f.guess)}</select>
          </div>
          ${dupe ? `<div class="src">Already on the calendar</div>` : it.kind === 'txt' ? `<div class="src">From: “${esc(it.row.line.slice(0, 120))}”</div>` : ''}</div>`;
      }).join('')}</div>`).join('')}
    </div>
    <div class="actions"><button class="btn primary" id="addAll">Add events</button><button class="btn" id="skipAll">None of these</button></div>`;
  const btn = $('#addAll');
  const count = () => { const n = $$('#rows .rrow > input:checked').length; btn.textContent = n ? `Add ${n} event${n === 1 ? '' : 's'}` : 'Add events'; btn.disabled = !n; };
  $$('#rows .rrow > input').forEach((c) => (c.onchange = count));
  count();
  $('#skipAll').onclick = () => { markSeen(ids); closeModal(); toast('Okay — those emails won’t show up again'); };
  btn.onclick = async () => {
    const out = [];
    for (const row of $$('#rows .rrow')) {
      if (!$('input[type=checkbox]', row).checked) continue;
      const it = found[+row.dataset.m].items[+row.dataset.i];
      const v = (f) => $(`[data-f=${f}]`, row).value.trim();
      const calId = v('cal'), title = v('title') || 'Event', date = v('date'), time = v('time');
      if (!validDate(date)) continue;
      const start = time ? `${date}T${time}` : date;
      let end;
      if (it.kind === 'ics') {
        const mins = (Date.parse((it.ev.end.includes('T') ? it.ev.end : it.ev.end + 'T00:00') + 'Z') - Date.parse((it.ev.start.includes('T') ? it.ev.start : it.ev.start + 'T00:00') + 'Z')) / 60000;
        end = time ? addMinutes(start, mins > 0 && it.ev.start.includes('T') ? mins : 60) : addDays(date, Math.max(1, Math.round(mins / 1440)) || 1);
      } else end = !time ? addDays(date, 1) : it.row.endTime && it.row.time === time ? `${date}T${it.row.endTime}` : addMinutes(start, 60);
      if (end <= start) end = addMinutes(start, 60);
      out.push({ id: hashId(calId + '|' + start + '|' + title), cal: calId, title, start, end, allDay: !time, location: v('location'),
        notes: it.kind === 'ics' ? it.ev.notes : `From email: ${found[+row.dataset.m].subject}`, source: 'email' });
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let added = 0;
      await saveCal((d) => {
        const have = new Set(d.events.map((e) => e.id));
        for (const e of out) if (!have.has(e.id)) { d.events.push(e); added++; }
      }, `Add ${out.length} events from email`);
      markSeen(ids);
      closeModal();
      toast(`Added ${added} event${added === 1 ? '' : 's'} from email`);
    } catch (err) { count(); toast(err.message, 5000); }
  };
}

/* ---------- drag & drop anywhere ---------- */
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e) || !S.cal) return; dragDepth++; $('#drop').classList.remove('hidden'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('#drop').classList.add('hidden');
  if (!S.cal) return;
  if (!isEditor()) return toast('Add your GitHub token in Settings to import.', 4000);
  const files = [...e.dataTransfer.files];
  if ($('#review') && !$('#modal').classList.contains('hidden')) handleFiles(files);
  else openImport(files);
});

/* ---------- settings ---------- */
function feedStatus(c) {
  if (!c.feedUrl) return '';
  const st = S.feeds.status?.[c.id];
  if (!st) return `<span class="st muted">Waiting for first sync…</span>`;
  return st.ok ? `<span class="st ok">✓ ${st.count} events · synced ${new Date(st.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`
    : `<span class="st bad">⚠ ${esc(st.error)} — check the link</span>`;
}

function calRow(c) {
  return `<div class="calrow" data-id="${esc(c.id)}">
    <input type="color" value="${esc(c.color)}" ${isEditor() ? '' : 'disabled'} aria-label="Color">
    <input class="in name" value="${esc(c.name)}" placeholder="Calendar name" ${isEditor() ? '' : 'disabled'}>
    ${isEditor() ? `<button class="btn icon ghost del" aria-label="Remove">✕</button>` : '<span></span>'}
    ${isEditor() ? `<input class="in feed" value="${esc(c.feedUrl || '')}" placeholder="Team calendar link (GameChanger, SportsYou…) — optional">
      <label class="check share"><input type="checkbox" class="shared" ${isShared(c) ? 'checked' : ''}> Extended family can see</label>` : ''}
    ${feedStatus(c)}
  </div>`;
}

function openSettings() {
  const url = location.origin + location.pathname;
  const sh = openModal(`
    <div class="head"><div><h2>Settings</h2></div><button class="btn icon ghost" data-close aria-label="Close">✕</button></div>

    <h4>Calendars</h4>
    <div id="cals">${S.cal.calendars.map(calRow).join('')}</div>
    ${isEditor() ? `
      <div class="actions"><button class="btn" id="addCal">+ Add calendar</button><button class="btn primary" id="saveCals">Save calendars</button></div>
      <details class="help" style="margin-top:12px"><summary><b>Where do I find a team’s calendar link?</b></summary>
        <p><b>GameChanger:</b> open the team → Schedule → the ⋯ / share icon → <i>Sync to Calendar</i> (or <i>Subscribe</i>) → copy the link.</p>
        <p><b>SportsYou:</b> open the team → Calendar → ⋯ → <i>Sync Calendar</i> / <i>Subscribe</i> → copy the link.</p>
        <p>Links starting with <code>webcal://</code> or ending in <code>.ics</code> both work. New games show up within about 2 hours, or tap Sync now.</p>
      </details>
      <div class="actions"><button class="btn" id="syncNow">Sync team feeds now</button></div>` : ''}

    <h4>This device</h4>
    ${S.relative ? '' : `<label class="f">GitHub token (only needed to add or change events)</label>
    <input class="in" id="tok" type="password" value="${esc(S.token || '')}" placeholder="github_pat_…">`}
    <div class="actions">${S.relative ? '' : `<button class="btn" id="saveTok">${S.token ? 'Update token' : 'Become an editor'}</button>
      ${S.token ? `<button class="btn ghost" id="dropTok">Remove token</button>` : ''}`}
      <button class="btn ghost danger" id="lockBtn">Lock this device</button></div>

    ${isEditor() ? `<h4>Email scanning (you two only)</h4>
    <p class="help">Lets each editor scan their own Gmail from their own phone. Needs a one-time Google setup — paste the <b>Client ID</b> here. Relatives never see this.</p>
    <label class="f">Google OAuth Client ID</label>
    <input class="in" id="gcid" autocomplete="off" value="${esc(googleClientId())}" placeholder="1234…apps.googleusercontent.com">
    <div class="actions"><button class="btn" id="saveGcid">Save</button></div>` : ''}

    ${isEditor() ? `<h4>Extended family</h4>
    <p class="help">Relatives get their own passcode and only see calendars marked “Extended family can see” (sports, church, etc.). Your Family calendar stays private. Updates reach them about a minute after you save.</p>
    <label class="f">Extended family passcode</label>
    <input class="in" id="relPass" type="text" autocomplete="off" value="${esc(S.cal.relativesPass || '')}" placeholder="Something different from yours">
    <div class="actions"><button class="btn" id="saveRel">Save passcode</button><button class="btn" id="copyLink">Copy link</button></div>
    <p class="help">Send relatives the link and this passcode. Everything is encrypted before it’s saved to GitHub.</p>` : `<div class="actions"><button class="btn" id="copyLink">Copy link</button></div>`}`);
  $('[data-close]', sh).onclick = closeModal;

  if (isEditor()) {
    const wireRow = (row) => ($('.del', row).onclick = () => row.remove());
    $$('.calrow', sh).forEach(wireRow);
    $('#addCal').onclick = () => {
      const div = document.createElement('div');
      const palette = ['#0891b2', '#db2777', '#65a30d', '#ca8a04', '#4f46e5', '#0d9488'];
      div.innerHTML = calRow({ id: '', name: '', shared: true, color: palette[S.cal.calendars.length % palette.length] });
      const row = div.firstElementChild;
      $('#cals').appendChild(row);
      wireRow(row);
      $('.name', row).focus();
    };
    $('#saveCals').onclick = async () => {
      const used = new Set();
      const cals = $$('.calrow', sh).map((row) => {
        const name = $('.name', row).value.trim();
        if (!name) return null;
        let id = row.dataset.id || slug(name);
        while (used.has(id)) id += '-2';
        used.add(id);
        const feedUrl = $('.feed', row).value.trim();
        return { id, name, color: $('input[type=color]', row).value, shared: $('.shared', row).checked, ...(feedUrl ? { feedUrl } : {}) };
      }).filter(Boolean);
      const removed = S.cal.calendars.filter((c) => !cals.some((x) => x.id === c.id));
      let dropEvents = false;
      if (removed.length) {
        const n = S.cal.events.filter((e) => removed.some((c) => c.id === e.cal)).length;
        if (n) dropEvents = confirm(`Also delete the ${n} event${n === 1 ? '' : 's'} on ${removed.map((c) => c.name).join(', ')}?`);
      }
      const feedsChanged = JSON.stringify(cals.map((c) => c.feedUrl || '')) !== JSON.stringify(S.cal.calendars.map((c) => c.feedUrl || ''));
      try {
        await saveCal((d) => {
          d.calendars = cals;
          if (dropEvents) d.events = d.events.filter((e) => !removed.some((c) => c.id === e.cal));
        }, 'Update calendars');
        closeModal();
        toast(feedsChanged ? 'Saved — team schedules will appear in a couple of minutes' : 'Saved', 4000);
        if (feedsChanged) setTimeout(refresh, 120000);
      } catch (err) { toast(err.message, 5000); }
    };
    $('#syncNow').onclick = async () => {
      try {
        const r = await fetch(`${GH}/actions/workflows/sync-feeds.yml/dispatches`, { method: 'POST', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: CONFIG.branch }) });
        if (r.status === 404) {
          const cur = await readFile(WORKFLOW_PATH, { api: true });
          await writeFile(WORKFLOW_PATH, WORKFLOW_YML, cur.sha, 'Add team feed sync');
          toast('Installed the sync — it runs in a minute', 4000);
        } else if (!r.ok) throw new Error('Couldn’t start the sync (' + r.status + '). Your token needs Actions: Read and write.');
        else toast('Syncing — new games appear in a minute or two', 4000);
        setTimeout(refresh, 90000);
      } catch (err) { toast(err.message, 6000); }
    };
  }
  if ($('#saveGcid')) $('#saveGcid').onclick = async () => {
    const v = $('#gcid').value.trim();
    if (v && !/\.apps\.googleusercontent\.com$/.test(v)) return toast('That doesn’t look like a Client ID (ends in .apps.googleusercontent.com)', 5000);
    try { await saveCal((d) => { if (v) d.googleClientId = v; else delete d.googleClientId; }, 'Update email scanning'); closeModal(); toast(v ? 'Email scanning is on — tap ✉︎ Scan email' : 'Email scanning turned off', 4000); }
    catch (err) { toast(err.message, 5000); }
  };
  if ($('#saveRel')) $('#saveRel').onclick = async () => {
    const v = $('#relPass').value.trim();
    if (v && v.length < 6) return toast('Use at least 6 characters');
    if (v && v === S.pass) return toast('Use a different passcode than your own');
    try { await saveCal((d) => { if (v) d.relativesPass = v; else delete d.relativesPass; }, 'Update extended family access'); closeModal(); toast(v ? 'Saved — relatives can open it in about a minute' : 'Extended family access turned off', 4000); }
    catch (err) { toast(err.message, 5000); }
  };
  if ($('#saveTok')) $('#saveTok').onclick = () => {
    const t = $('#tok').value.trim();
    if (!t) return toast('Paste a token first');
    S.token = t; store.set('token', t); closeModal(); renderMain(); toast('You can now add and import events');
  };
  if ($('#dropTok')) $('#dropTok').onclick = () => { S.token = null; store.set('token', null); closeModal(); renderMain(); };
  $('#lockBtn').onclick = () => { store.set('pass', null); S.pass = null; S.cal = null; closeModal(); renderLock(); };
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { prompt('Copy this link:', url); }
  };
}

/* ---------- refresh ---------- */
async function refresh() {
  if (!S.pass || !$('#modal').classList.contains('hidden')) return;
  try {
    const f = await readFile(S.relative ? SHARED_FILE : CAL_FILE);
    if (f.text) { S.cal = await decryptJSON(f.text, S.pass); if (!S.relative) S.calSalt = saltOf(f.text); }
    await loadFeeds();
    S.loadedAt = Date.now();
    renderMain();
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.pass && Date.now() - S.loadedAt > 5 * 60 * 1000) refresh();
});

boot();
