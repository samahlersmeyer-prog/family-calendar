import { encryptJSON, decryptJSON, saltOf, encryptBytes, decryptBytes, bytesToB64 } from './lib/crypto.js?v=10';
import { parseICS, hashId } from './lib/ics.js?v=10';
import { parseScheduleText } from './lib/schedule-text.js?v=10';
import { todayWall, addDays, addMinutes, dow, validDate, utcToWall } from './lib/tz.js?v=10';
import { WORKFLOW_PATH, WORKFLOW_YML } from './lib/workflow.js?v=10';
import { classifyMail, scoreRow, mergeRows, splitSentences, KEEP_SCORE, CHECK_SCORE } from './lib/mail-filter.js?v=10';

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
  inbox: { events: [] },
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
  await loadInbox();
  await claimEditorLink();
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
const FRIENDS = { id: 'friends', name: 'Family & Friends', color: '#0891b2', shared: true };
const calById = (id) => S.cal.calendars.find((c) => c.id === id) || (id === 'friends' ? FRIENDS : { id, name: 'Other', color: '#94a3b8' });
const visibleCalendars = () => [...S.cal.calendars, ...(familyAddOn() ? [FRIENDS] : [])];

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.82;
}
const swatch = (c) => `background:${esc(c)};${isLight(c) ? 'box-shadow:inset 0 0 0 1.5px var(--muted);' : ''}`;

function allEvents() {
  const seen = new Set();
  const out = [];
  // A team-feed game that matches a game already on the same calendar that day is merged into it:
  // the feed's time and place win (so changes flow in), the event keeps its title, notes and attachments.
  const manual = new Map();
  for (const e of S.cal.events) if (!e.allDay && !/practice|indoor/i.test(e.title)) manual.set(e.cal + '|' + e.start.slice(0, 10), e);
  const merged = new Map();
  const feeds = [];
  for (const f of S.feeds.events || []) {
    const m = !f.allDay && manual.get(f.cal + '|' + f.start.slice(0, 10));
    if (m) {
      // Keep our full address unless the team app points somewhere else (compare street numbers + names)
      const fl = (f.location || '').replace(/\s*\n\s*/g, ', ').trim();
      const street = fl.split(',')[0].toLowerCase();
      const location = !fl || (m.location || '').toLowerCase().includes(street) ? m.location : fl;
      merged.set(m.id, { ...m, start: f.start, end: f.end, location, feedId: f.id });
    }
    else feeds.push(f);
  }
  for (const e0 of [...S.cal.events, ...feeds, ...(S.inbox.events || [])]) {
    const e = merged.get(e0.id) || e0;
    if (seen.has(e.id) || S.hidden.has(e.cal)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}
const findEvent = (id) => allEvents().find((e) => e.id === id) || S.cal.events.find((e) => e.id === id) || (S.feeds.events || []).find((e) => e.id === id) || (S.inbox.events || []).find((e) => e.id === id);

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

/* plain-English labels */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayLabel(d) {
  const t = todayWall();
  if (d === t) return 'Today';
  if (d === addDays(t, 1)) return 'Tomorrow';
  if (d > t && d <= addDays(t, 6)) return WEEKDAYS[dow(d)];
  return fmtDay(d);
}
function dateLine(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return `${WEEKDAYS[dow(d)]}, ${MONTHS[m - 1]} ${dd}${y !== +todayWall().slice(0, 4) ? ', ' + y : ''}`;
}
function timeRange(e) {
  if (e.allDay) {
    const last = e.end ? addDays(e.end.slice(0, 10), -1) : e.start;
    return last > e.start.slice(0, 10) ? `All day · through ${fmtDay(last)}` : 'All day';
  }
  const s = fmtTime(e.start), en = e.end && e.end.slice(0, 10) === e.start.slice(0, 10) ? fmtTime(e.end) : '';
  if (!en) return s;
  return s.slice(-2) === en.slice(-2) ? `${s.slice(0, -3)} – ${en}` : `${s} – ${en}`;
}
const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
const mapsUrl = (loc) => isApple ? `https://maps.apple.com/?q=${encodeURIComponent(loc)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;

function nextUp() {
  const now = utcToWall(new Date()), today = now.slice(0, 10);
  return allEvents()
    .filter((e) => e.allDay ? (e.end || addDays(e.start, 1)).slice(0, 10) > today && e.start.slice(0, 10) >= today : (e.end || e.start) > now)
    .filter((e) => !/no school|no indoor|break\b/i.test(e.title))
    .sort((a, b) => a.start.localeCompare(b.start))[0];
}

function whoChip(c) {
  return `<span class="who"><i style="${swatch(c.color)}"></i>${esc(c.name)}</span>`;
}

function evRow(e) {
  const c = calById(e.cal);
  const t = e.allDay ? 'All day' : fmtTime(e.start);
  const end = !e.allDay && e.end && e.end.slice(0, 10) === e.start.slice(0, 10) ? fmtTime(e.end) : '';
  return `<div class="ev" role="button" tabindex="0" data-ev="${esc(e.id)}"><span class="bar" style="${swatch(c.color)}"></span>
    <span class="t">${t}${end ? `<small>to ${end}</small>` : ''}</span>
    <span class="b"><b>${e.private && !S.relative ? '<span class="lock" title="Only you two">🔒</span> ' : ''}${esc(e.title)}</b>
      ${whoChip(c)}
      ${e.location ? `<a class="where" href="${mapsUrl(e.location)}" target="_blank" rel="noopener" data-stop>📍 ${esc(e.location)}</a>` : ''}
      ${e.addedBy ? `<small class="muted">Added by ${esc(e.addedBy)}</small>` : ''}</span></div>`;
}

/* ---------- main screen ---------- */
function renderMain() {
  const family = !S.relative; // you and Emily (with or without this phone set up yet)
  const canAdd = isEditor() || canFamilyAdd();
  const day = () => (S.view === 'month' ? S.day : todayWall());
  app.innerHTML = `
  <header class="top">
    <div class="row1">
      <div class="brand">${esc(S.cal.title || 'Family Calendar')}</div>
    </div>
    <div class="row2">
      <div class="seg"><button data-view="list" class="${S.view === 'list' ? 'on' : ''}">Upcoming</button><button data-view="month" class="${S.view === 'month' ? 'on' : ''}">Month</button></div>
    </div>
  </header>
  ${welcomeBanner()}
  <nav class="chips" aria-label="Show or hide calendars">${visibleCalendars().map((c) => `<button class="chip ${S.hidden.has(c.id) ? 'off' : ''}" data-cal="${esc(c.id)}"><i style="${swatch(c.color)}"></i>${esc(c.name)}</button>`).join('')}</nav>
  <main id="view"></main>
  <nav class="tabbar" aria-label="Menu">
    <button data-tab="cal"><span>📅</span>Calendar</button>
    ${family || canAdd ? `<button data-tab="add" class="addtab"><span>＋</span>Add</button>` : ''}
    ${family ? `<button data-tab="email"><span>✉️</span>Email</button><button data-tab="import"><span>📄</span>Import</button>` : ''}
    <button data-tab="settings"><span>⚙️</span>Settings</button>
  </nav>`;
  $$('[data-view]').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; store.set('view', S.view); renderMain(); }));
  $$('[data-cal]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.cal;
    S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
    store.set('hidden', JSON.stringify([...S.hidden]));
    renderMain();
  }));
  if ($('#welcomeX')) $('#welcomeX').onclick = () => { store.set(S.relative ? 'welcomedRel' : 'welcomedEd', '1'); renderMain(); };
  const needEditor = (fn) => () => (isEditor() ? fn() : openUnlockEditor(fn));
  const actions = {
    cal: () => { if (S.view !== 'list') { S.view = 'list'; store.set('view', 'list'); renderMain(); } scrollTo({ top: 0, behavior: 'smooth' }); },
    add: () => (S.relative ? openFamilyAdd(day()) : needEditor(() => openEdit(null, day()))()),
    email: needEditor(() => openImport(null, 'email')),
    import: needEditor(() => openImport()),
    settings: openSettings,
  };
  $$('[data-tab]', $('.tabbar')).forEach((b) => (b.onclick = () => actions[b.dataset.tab]()));
  S.view === 'month' ? renderMonth() : renderList();
}

/* ---------- editor setup on a new phone ---------- */
function openUnlockEditor(then) {
  const sh = openModal(`
    <div class="head"><div><h2>Set up this phone</h2><p class="help">One time per phone. After this you can add events, scan email and import schedules here.</p></div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="steps-card">
      <b>Easiest:</b> on a phone or computer that’s already set up, open <b>⚙️ Settings → Set up another phone</b>, then scan the QR code with this phone’s camera (or open the link it gives you).
    </div>
    <label class="f">Or paste the GitHub token</label>
    <input class="in" id="unTok" type="password" placeholder="github_pat_…" autocomplete="off">
    <div class="actions"><button class="btn primary big" id="unGo">Set up this phone</button></div>`);
  $('[data-close]', sh).onclick = closeModal;
  $('#unGo').onclick = async () => {
    const t = $('#unTok').value.trim();
    if (!/^(github_pat_|ghp_)/.test(t)) return toast('That doesn’t look like a GitHub token', 4000);
    if (!(await checkToken(t))) return toast('That token didn’t work for this calendar', 5000);
    S.token = t; store.set('token', t); closeModal(); renderMain(); toast('This phone is set up ✓');
    if (then) then();
  };
}
async function checkToken(t) {
  try {
    const r = await fetch(GH, { headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' } });
    return r.ok && (await r.json()).permissions?.push;
  } catch { return false; }
}
/** A link that sets up another phone: the token travels encrypted with the family passcode. */
async function editorLink() {
  const blob = await encryptJSON({ t: S.token }, S.pass);
  return location.origin + location.pathname + '#editor=' + encodeURIComponent(btoa(blob));
}
async function claimEditorLink() {
  const m = location.hash.match(/editor=([^&]+)/);
  if (!m || S.relative || !S.pass) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { t } = await decryptJSON(atob(decodeURIComponent(m[1])), S.pass);
    if (t && (await checkToken(t))) { S.token = t; store.set('token', t); renderMain(); toast('This phone is set up to add and edit ✓', 4000); }
  } catch { toast('That setup link didn’t match this calendar’s passcode', 5000); }
}

function welcomeBanner() {
  if (S.relative && !store.get('welcomedRel')) return `<div class="welcome"><div><b>Welcome! 👋</b> These are the Ahlersmeyer kids’ games, programs and events.
    Tap any event for the time, place and directions.${canFamilyAdd() ? ' Tap <b>+ Add</b> to put your own family event on the calendar.' : ''}
    ${isApple ? ' Tip: tap <b>Share → Add to Home Screen</b> to keep it one tap away.' : ''}</div><button class="btn icon ghost" id="welcomeX" aria-label="Got it">✕</button></div>`;
  if (!S.relative && isEditor() && !store.get('welcomedEd')) return `<div class="welcome"><div><b>You’re an editor.</b> Tap <b>+ Add</b> for a new event, <b>✉︎ Email</b> to pull events from your Gmail, or <b>Import</b> to drop in a schedule PDF.
    Relatives see everything except the <b>Family</b> calendar and anything marked 🔒.</div><button class="btn icon ghost" id="welcomeX" aria-label="Got it">✕</button></div>`;
  return '';
}

function bindEvents(root) {
  $$('[data-stop]', root).forEach((a) => a.addEventListener('click', (ev) => ev.stopPropagation()));
  $$('[data-ev]', root).forEach((b) => {
    b.onclick = () => openDetail(b.dataset.ev);
    b.onkeydown = (ev) => { if (ev.key === 'Enter') openDetail(b.dataset.ev); };
  });
}

function renderList() {
  const view = $('#view');
  const from = todayWall(), to = addDays(from, 240);
  const idx = indexByDay(from, to);
  const days = Object.keys(idx).sort().slice(0, 90);
  const nu = nextUp();
  if (!days.length) {
    view.innerHTML = `<div class="empty"><p><b>Nothing coming up.</b></p><p>${isEditor() ? 'Tap + Add for an event, Import to drop in a schedule, or ✉︎ Email to scan your inbox.' : 'Check back soon.'}</p></div>`;
    return;
  }
  let lastWeek = '';
  view.innerHTML = (nu ? nextCard(nu) : '') + days.map((d) => {
    const label = dayLabel(d);
    const week = d <= addDays(from, 6) ? 'This week' : d <= addDays(from, 13) ? 'Next week' : MONTHS[+d.slice(5, 7) - 1];
    const wk = week !== lastWeek && week !== 'This week' ? `<div class="weekhead">${week}</div>` : '';
    lastWeek = week;
    return `${wk}<section class="day"><h3><span class="rel">${esc(label)}</span>${label === fmtDay(d) ? '' : `<span>${['Today', 'Tomorrow'].includes(label) ? dateLine(d) : MONTHS[+d.slice(5, 7) - 1] + ' ' + +d.slice(8)}</span>`}</h3>
    ${idx[d].map(evRow).join('')}</section>`;
  }).join('');
  bindEvents(view);
}

function nextCard(e) {
  const c = calById(e.cal);
  const d = e.start.slice(0, 10);
  const firstNote = (e.notes || '').split(/\n|(?<=\.)\s/)[0];
  return `<section class="next" data-ev="${esc(e.id)}" role="button" tabindex="0" style="--c:${esc(isLight(c.color) ? '#94a3b8' : c.color)}">
    <div class="nlabel">Next up · ${esc(dayLabel(d))}${dayLabel(d) === 'Today' || dayLabel(d) === 'Tomorrow' ? '' : ''}</div>
    <div class="ntitle">${esc(e.title)}</div>
    <div class="nwhen">${esc(dateLine(d))} · ${esc(timeRange(e))}</div>
    ${whoChip(c)}
    ${firstNote && firstNote.length < 140 ? `<div class="nnote">${esc(firstNote)}</div>` : ''}
    <div class="actions">${e.location ? `<a class="btn primary" href="${mapsUrl(e.location)}" target="_blank" rel="noopener" data-stop>📍 Directions</a>` : ''}<span class="btn">Details</span></div>
    ${e.location ? `<div class="nwhere">${esc(e.location)}</div>` : ''}
  </section>`;
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
        ${evs.slice(0, 3).map((e) => { const col = calById(e.cal).color; return `<span class="pill ${isLight(col) ? 'lightc' : ''}" style="--c:${esc(col)}">${e.allDay ? '' : `<span class="pt">${fmtTime(e.start, true)} </span>`}${esc(e.title)}</span>`; }).join('')}
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
  $('#daylist').innerHTML = `<h3><span class="rel">${esc(dayLabel(S.day))}</span><span>${dateLine(S.day)}</span></h3>${evs.length ? evs.map(evRow).join('') : '<p class="muted">Nothing this day.</p>'}`;
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

/** One event as a .ics file, so anyone can add it to their own phone calendar. */
function eventIcs(e) {
  const fmt = (w) => w.includes('T') ? w.replace(/[-:]/g, '') + '00' : w.replace(/-/g, '');
  const escI = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&');
  const end = e.end || (e.allDay ? addDays(e.start, 1) : addMinutes(e.start, 60));
  const tz = e.allDay ? ';VALUE=DATE' : ';TZID=America/Indiana/Indianapolis';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Calendar//EN', 'BEGIN:VEVENT', `UID:${e.id}@family-calendar`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART${tz}:${fmt(e.start)}`, `DTEND${tz}:${fmt(end)}`,
    `SUMMARY:${escI(e.title)}`, e.location ? `LOCATION:${escI(e.location)}` : '', e.notes ? `DESCRIPTION:${escI(e.notes)}` : '',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}

function openDetail(id) {
  const e = findEvent(id);
  if (!e) return;
  const c = calById(e.cal);
  const d = e.start.slice(0, 10);
  const fromFeed = e.source === 'feed';
  const fromFamily = e.cal === 'friends';
  const mine = fromFamily && JSON.parse(store.get('myAdds') || '[]').includes(e.id);
  const canEdit = isEditor() && !fromFeed && !fromFamily;
  const canDelete = canEdit || (fromFamily && (isEditor() || mine));
  const sh = openModal(`
    <div class="head"><div><h2>${esc(e.title)}</h2>${whoChip(c)}</div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="meta big">
      <div><span class="k">When</span><b>${['Today', 'Tomorrow'].includes(dayLabel(d)) ? esc(dayLabel(d)) + ' · ' : ''}${esc(dateLine(d))}</b><br>${esc(timeRange(e))}</div>
      ${e.location ? `<div><span class="k">Where</span><b>${esc(e.location)}</b></div>` : ''}
      ${e.notes ? `<div class="notes">${esc(e.notes)}</div>` : ''}
      ${e.addedBy ? `<div class="help">Added by ${esc(e.addedBy)}</div>` : ''}
      ${e.private && !S.relative ? `<div class="help">🔒 Only you two — extended family doesn’t see this</div>` : ''}
      ${fromFeed ? `<div class="help">Synced from the team’s calendar — changes come from the team app.</div>` : ''}
    </div>
    <div class="actions stack">
      ${e.location ? `<a class="btn primary" href="${mapsUrl(e.location)}" target="_blank" rel="noopener">📍 Get directions</a>` : ''}
      ${(e.attachments || []).map((a, i) => `<button class="btn" data-att="${i}">📎 ${esc(a.name)}</button>`).join('')}
      <button class="btn" id="addPhone">📅 Add to my phone calendar</button>
    </div>
    ${canEdit || canDelete ? `<div class="actions">${canEdit ? `<button class="btn" id="edit">Edit</button>` : ''}${canDelete ? `<button class="btn danger" id="del">Delete</button>` : ''}</div>` : ''}`);
  $('[data-close]', sh).onclick = closeModal;
  $('#addPhone').onclick = () => {
    const url = URL.createObjectURL(new Blob([eventIcs(e)], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url; a.download = (e.title.replace(/[^\w\s-]/g, '').trim() || 'event') + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  $$('[data-att]', sh).forEach((b) => (b.onclick = () => openAttachment(e.attachments[+b.dataset.att])));
  if (canEdit) $('#edit').onclick = () => openEdit(e);
  if (canDelete) $('#del').onclick = async () => {
    if (!confirm(`Delete “${e.title}”?`)) return;
    try {
      if (fromFamily) await saveInbox((d) => { d.events = d.events.filter((x) => x.id !== e.id); });
      else await saveCal((d) => { d.events = d.events.filter((x) => x.id !== e.id); }, `Delete: ${e.title}`);
      closeModal(); toast('Deleted');
    } catch (err) { toast(err.message, 5000); }
  };
}

let qrReady;
const loadQR = () => (qrReady ||= new Promise((res, rej) => {
  const sc = document.createElement('script');
  sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  sc.onload = res; sc.onerror = () => { qrReady = null; rej(); };
  document.head.appendChild(sc);
}));

/* ---------- attachments ---------- */
const ATT_MAX = 15 * 1024 * 1024;
async function uploadAttachment(file) {
  if (file.size > ATT_MAX) throw new Error(`${file.name} is too big (15 MB max)`);
  const { data, key } = await encryptBytes(new Uint8Array(await file.arrayBuffer()));
  const path = `attachments/${newId()}.bin`;
  const r = await fetch(`${GH}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Attach ${file.name}`, content: bytesToB64(data), branch: CONFIG.branch }),
  });
  if (!r.ok) throw new Error(`Couldn’t upload ${file.name} (${r.status})`);
  return { name: file.name.replace(/\.[^.]+$/, ''), path, key, type: file.type || 'application/pdf' };
}
async function openAttachment(a) {
  const win = window.open('', '_blank'); // open now so phones don't block it
  try {
    if (win) win.document.write('<p style="font:16px system-ui;padding:20px">Opening…</p>');
    const r = await fetch(`https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${a.path}`, { cache: 'force-cache' });
    if (!r.ok) throw new Error('Couldn’t load the file (' + r.status + ')');
    const bytes = await decryptBytes(await r.arrayBuffer(), a.key);
    const url = URL.createObjectURL(new Blob([bytes], { type: a.type }));
    if (win) win.location.href = url; else location.href = url;
  } catch (err) { if (win) win.close(); toast(err.message, 5000); }
}

/* ---------- extended family can add events (separate "inbox" repo) ---------- */
// The inbox is a small second GitHub repo that only holds relatives' events, encrypted
// with the extended-family passcode. Its token can only touch that repo.
const inboxCfg = () => S.cal.inbox || null;
const inboxKey = () => S.relative ? S.pass : S.cal.relativesPass;
const familyAddOn = () => !!(inboxCfg()?.repo && inboxCfg()?.token && inboxKey());
const canFamilyAdd = () => S.relative && familyAddOn();

async function inboxReq(method, body) {
  const { repo, token } = inboxCfg();
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/inbox.enc${method === 'GET' ? `?t=${Date.now()}` : ''}`, {
    method, cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r;
}
async function loadInbox() {
  S.inbox = { events: [] };
  if (!familyAddOn()) return;
  try {
    const r = await inboxReq('GET');
    if (r.status === 404) return;
    if (!r.ok) return;
    const j = await r.json();
    const data = await decryptJSON(unb64utf8(j.content), inboxKey());
    S.inbox = { events: (data.events || []).map((e) => ({ ...e, cal: 'friends' })), sha: j.sha };
  } catch { S.inbox = { events: [] }; }
}
async function saveInbox(mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await inboxReq('GET');
    let data = { events: [] }, sha;
    if (r.ok) { const j = await r.json(); sha = j.sha; data = await decryptJSON(unb64utf8(j.content), inboxKey()); }
    else if (r.status !== 404) throw new Error('Couldn’t reach the family calendar (' + r.status + ')');
    mutate(data);
    const w = await inboxReq('PUT', { message: 'Family event update', content: b64utf8(await encryptJSON(data, inboxKey())), ...(sha ? { sha } : {}) });
    if (w.ok) { S.inbox = { events: data.events.map((e) => ({ ...e, cal: 'friends' })) }; renderMain(); return; }
    if (w.status === 409 || w.status === 422) continue;
    throw new Error('Couldn’t save (' + w.status + ')');
  }
  throw new Error('Someone else is saving right now — try again.');
}

function openFamilyAdd(day) {
  const name = store.get('myName') || '';
  const sh = openModal(`
    <div class="head"><div><h2>Add a family event</h2><p class="help">Everyone in the family will see it — birthdays, dinners, visits, anything.</p></div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <form id="ff">
      <label class="f">What’s happening?</label><input class="in" name="title" required placeholder="e.g. Grandma’s birthday dinner">
      <div class="two"><div><label class="f">Date</label><input class="in" type="date" name="date" value="${day}" required></div>
        <div><label class="f">Time <span class="muted">(optional)</span></label><input class="in" type="time" name="time"></div></div>
      <label class="f">Where? <span class="muted">(optional)</span></label><input class="in" name="location" placeholder="Address or place name">
      <label class="f">Anything else? <span class="muted">(optional)</span></label><textarea class="in" name="notes" style="min-height:70px"></textarea>
      <label class="f">Your name</label><input class="in" name="who" value="${esc(name)}" required placeholder="So everyone knows who added it">
      <div class="actions"><button class="btn primary big">Add to calendar</button></div>
    </form>`);
  $('[data-close]', sh).onclick = closeModal;
  const f = $('#ff');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const date = f.date.value, time = f.time.value;
    const start = time ? `${date}T${time}` : date;
    const e = { id: newId(), title: f.title.value.trim(), start, end: time ? addMinutes(start, 90) : addDays(date, 1), allDay: !time,
      location: f.location.value.trim(), notes: f.notes.value.trim(), addedBy: f.who.value.trim(), source: 'family' };
    store.set('myName', e.addedBy);
    const btn = $('button.primary', f);
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      await saveInbox((d) => { d.events = [...(d.events || []), e]; });
      store.set('myAdds', JSON.stringify([...JSON.parse(store.get('myAdds') || '[]'), e.id].slice(-300)));
      closeModal(); toast('Added — thanks!');
    } catch (err) { btn.disabled = false; btn.textContent = 'Add to calendar'; toast(err.message, 5000); }
  };
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
      <label class="check"><input type="checkbox" name="priv" ${e.private ? 'checked' : ''}> Only us (hide from extended family)</label>
      <p class="help">The Family calendar is always just you two. Sports, school and church calendars are shared with relatives unless you check this.</p>
      <div class="two timed ${e.allDay ? 'hidden' : ''}"><div><label class="f">Starts</label><input class="in" type="time" name="st" value="${e.allDay ? '18:00' : e.start.slice(11, 16)}"></div>
        <div><label class="f">Ends</label><input class="in" type="time" name="et" value="${!e.allDay && e.end ? e.end.slice(11, 16) : ''}"></div></div>
      <label class="f">Where</label><input class="in" name="location" value="${esc(e.location)}">
      <label class="f">Notes</label><textarea class="in" name="notes" style="min-height:80px">${esc(e.notes)}</textarea>
      <label class="f">Attachments <span class="muted">(schedule, bracket, flyer — PDF or photo)</span></label>
      <div id="atts">${(e.attachments || []).map((a, i) => `<div class="att"><span>📎 ${esc(a.name)}</span><button type="button" class="btn icon ghost" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
      <label class="dropzone small"><input type="file" name="files" accept="application/pdf,image/*" multiple hidden><b>+ Attach a file</b></label>
      <div id="newatts" class="help"></div>
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>`);
  $('[data-close]', sh).onclick = closeModal;
  const f = $('#ef');
  let keep = [...(e.attachments || [])];
  $$('[data-rm]', f).forEach((b) => (b.onclick = () => { keep = keep.filter((_, i) => i !== +b.dataset.rm); b.closest('.att').remove(); }));
  f.files.onchange = () => { $('#newatts').textContent = [...f.files.files].map((x) => '📎 ' + x.name).join('  '); };
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
    if (f.priv.checked) out.private = true; else delete out.private;
    store.set('lastCal', out.cal);
    const btn = $('button.primary', f);
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const added = [];
      for (const file of f.files.files) {
        btn.textContent = `Uploading ${file.name}…`;
        added.push(await uploadAttachment(file));
      }
      out.attachments = [...keep, ...added];
      if (!out.attachments.length) delete out.attachments;
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
const MAIL_QUERY = '-category:promotions -category:social -category:forums -in:spam (filename:ics OR invite OR invitation OR schedule OR practice OR game OR games OR tournament OR rehearsal OR recital OR program OR concert OR party OR appointment OR "save the date" OR reminder OR choir OR sing OR singing OR "field trip" OR conference OR meet OR tryouts OR banquet OR birthday OR camp OR clinic)';

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
      ${[7, 14, 30, 60].map((d) => `<option value="${d}" ${!since && d === 30 ? 'selected' : ''}>Last ${d} days</option>`).join('')}
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
  const body = trimBody(plain || htmlToText(html));
  const guess = guessCalText(`${subject} ${from} ${body.slice(0, 800)}`);
  const bulk = !!(h['list-unsubscribe'] || /bulk|list/i.test(h.precedence || ''));
  const mail = classifyMail({ subject, from, body, bulk, hasInvite: items.length > 0 });
  if (!items.length && !mail.junk) {
    const today = todayWall(), keys = new Set();
    const cleanSubject = subject.replace(/^((re|fwd?|fw):\s*)+/i, '').slice(0, 70);
    for (const r of mergeRows(parseScheduleText(splitSentences(cleanSubject + '\n' + body)))) {
      if (r.date < today || r.date > addDays(today, 400)) continue;
      const score = scoreRow(r, mail);
      if (score < KEEP_SCORE) continue;
      const k = r.date + '|' + r.time;
      if (keys.has(k)) continue;
      keys.add(k);
      const words = (r.title || '').split(/\s+/).length;
      const title = r.title && r.title.length >= 3 && words <= 7 ? r.title : cleanSubject;
      items.push({ kind: 'txt', score, row: { ...r, title } });
      if (items.length >= 8) break;
    }
  }
  return { id: m.id, subject, from, items, guess, junk: mail.junk };
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
      try {
        const mail = await extractMail(await gm(`/messages/${ids[i]}?format=full`, token), token);
        if (mail.items.length) found.push(mail);
      } catch (e) {
        if (/sign-in expired|said no/.test(e.message)) throw e; // real Gmail problems stop the scan
        console.warn('Skipped an email:', e); // one odd email shouldn't stop the rest
      }
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
    review.innerHTML = `<p class="muted">${ids.length ? `Checked ${ids.length} new email${ids.length === 1 ? '' : 's'} — nothing you need to be at.` : 'No new emails to check.'}</p>`;
    return;
  }
  const rowOf = (it) => it.kind === 'ics'
    ? { title: it.ev.title, date: it.ev.start.slice(0, 10), time: it.ev.allDay ? '' : it.ev.start.slice(11, 16), location: it.ev.location }
    : { title: it.row.title, date: it.row.date, time: it.row.time || '', location: it.row.location || '' };
  review.innerHTML = `
    <h4>Events in ${found.length} email${found.length === 1 ? '' : 's'}</h4>
    <p class="help">Spam, sales, receipts, deliveries and money/stock emails are already filtered out. The likely events are checked — uncheck anything that isn’t a place you need to be, and fix titles if needed.</p>
    <div id="rows">${found.map((f, mi) => `
      <div class="mail"><div class="mailhead"><b>${esc(f.subject)}</b><small>${esc(f.from)}</small></div>
      ${f.items.map((it, ii) => {
        const r = rowOf(it);
        const dupe = existing.has(r.title.toLowerCase() + '|' + (r.time ? `${r.date}T${r.time}` : r.date));
        return `<div class="rrow" data-m="${mi}" data-i="${ii}"><input type="checkbox" ${(it.kind === 'ics' || it.score >= CHECK_SCORE) && !dupe ? 'checked' : ''}>
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

    ${isEditor() ? `<h4>Set up another phone</h4>
    <p class="help">For Emily (or your own phone): scan this with the phone’s camera, or send the link. They’ll enter the family passcode and that phone can add events and scan email.</p>
    <div id="qr" class="qr"></div>
    <div class="actions"><button class="btn" id="copySetup">Copy setup link</button></div>` : !S.relative ? `<h4>This phone</h4><p class="help">This phone can only view. <a href="#" id="unlockHere">Set it up to add events and scan email</a>.</p>` : ''}

    <h4>Text size</h4>
    <div class="seg"><button data-size="" class="${!store.get('textSize') ? 'on' : ''}">Normal</button><button data-size="big" class="${store.get('textSize') === 'big' ? 'on' : ''}">Larger</button><button data-size="huge" class="${store.get('textSize') === 'huge' ? 'on' : ''}">Largest</button></div>

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

    ${isEditor() ? `<h4>Let relatives add events</h4>
    ${familyAddOn() ? `<p class="help ok">✓ On — relatives see a <b>+ Add</b> button. Their events show on “Family & Friends”.</p>` : `<p class="help">Relatives can add their own events (birthdays, dinners, visits) with a simple form. One-time setup:</p>
    <ol class="steps help">
      <li>On GitHub, create a new <b>private</b> repository named <code>family-calendar-inbox</code> (check “Add a README”).</li>
      <li>Create a fine-grained token for <b>only that repo</b> with <b>Contents: Read and write</b>.</li>
      <li>Paste it below and save. (Set the extended family passcode first.)</li>
    </ol>`}
    <label class="f">Inbox repository</label>
    <input class="in" id="inRepo" value="${esc(inboxCfg()?.repo || CONFIG.owner + '/family-calendar-inbox')}">
    <label class="f">Inbox token</label>
    <input class="in" id="inTok" type="password" value="${esc(inboxCfg()?.token || '')}" placeholder="github_pat_…">
    <div class="actions"><button class="btn" id="saveInbox">Save</button></div>` : ''}

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
  if ($('#unlockHere')) $('#unlockHere').onclick = (ev) => { ev.preventDefault(); openUnlockEditor(); };
  if ($('#copySetup')) {
    editorLink().then((link) => {
      $('#copySetup').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Setup link copied — text it to Emily'); } catch { prompt('Copy this link:', link); } };
      loadQR().then(() => { const el = $('#qr'); if (el && window.QRCode) new window.QRCode(el, { text: link, width: 180, height: 180, correctLevel: window.QRCode.CorrectLevel.L }); }).catch(() => {});
    });
  }
  $$('[data-size]', sh).forEach((b) => (b.onclick = () => { store.set('textSize', b.dataset.size || null); applyTextSize(); closeModal(); openSettings(); }));
  if ($('#saveInbox')) $('#saveInbox').onclick = async () => {
    const repo = $('#inRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''), token = $('#inTok').value.trim();
    if (!S.cal.relativesPass) return toast('Set the extended family passcode first (just below)', 5000);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return toast('Fill in the repository and token', 4000);
    const btn = $('#saveInbox'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(r.status === 404 ? 'Can’t find that repository with this token' : 'Token was rejected (' + r.status + ')');
      const j = await r.json();
      if (!j.permissions?.push) throw new Error('This token can’t write to that repository — give it Contents: Read and write');
      await saveCal((d) => { d.inbox = { repo, token }; }, 'Let relatives add events');
      await loadInbox();
      closeModal(); toast('Done — relatives can now add events', 4000);
    } catch (err) { btn.disabled = false; btn.textContent = 'Save'; toast(err.message, 6000); }
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
    await loadInbox();
    S.loadedAt = Date.now();
    renderMain();
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.pass && Date.now() - S.loadedAt > 5 * 60 * 1000) refresh();
});

function applyTextSize() {
  document.documentElement.classList.remove('big', 'huge');
  const t = store.get('textSize');
  if (t) document.documentElement.classList.add(t);
}
applyTextSize();
boot();
