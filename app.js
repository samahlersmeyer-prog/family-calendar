import { encryptJSON, decryptJSON, encryptBytes, decryptBytes, bytesToB64 } from './lib/crypto.js?v=37';
import { parseICS, hashId } from './lib/ics.js?v=37';
import { parseScheduleText } from './lib/schedule-text.js?v=37';
import { todayWall, addDays, addMinutes, diffMinutes, dow, validDate, utcToWall, pad } from './lib/tz.js?v=37';
import { classifyMail, scoreRow, mergeRows, splitSentences, groupRows, KEEP_SCORE, CHECK_SCORE, EVENT, TICKETS } from './lib/mail-filter.js?v=37';
import { initCloud } from './lib/cloud.js?v=37';
import { CHORE_LIB, choreIcon, choresFor, setChoreDay, DAY_SHORT, DAY_LONG, itemDone, dueOn, repeatLabel as choreRepeat, MORNING_LIB, MORNING_DAYS, autoMode, } from './lib/chores.js?v=37';
import { REPEATS, occurrences, mergeFeeds, KINDS, kindOf, KIDS, calKid as calKidOf, titleKid as titleKidOf, forKid as forKidOf } from './lib/events.js?v=37';

/* ---------- config ---------- */
const CONFIG = { owner: 'samahlersmeyer-prog', repo: 'family-calendar', branch: 'main' };
const RAW = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/`;
const OWNERS = ['sam.ahlersmeyer@gmail.com', 'samahlersmeyer@gmail.com'];
const isShared = (c) => c.shared ?? c.id !== 'family';
// Google OAuth Client ID for Gmail scanning (not a secret).
const GOOGLE_CLIENT_ID = '854962669636-0i9dhtsofh30onsch64boiqmj804uhf3.apps.googleusercontent.com';
const googleClientId = () => GOOGLE_CLIENT_ID;

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
  user: null,          // signed-in Google account
  editor: false,       // Sam or Emily
  space: store.get('space'),
  cal: null,
  feeds: { events: [], status: {} },
  inbox: { events: [] },
  hidden: new Set(JSON.parse(store.get('hidden') || '[]')),
  view: store.get('view') || (innerWidth < 760 ? 'list' : 'month'),
  kid: store.get('kid') || '',
  week: null,
  rides: {},
  items: [],           // groceries + chores
  month: todayWall().slice(0, 7),
  day: todayWall(),
  loadedAt: 0,
  get relative() { return !this.editor; },
};
const isEditor = () => S.editor;
const app = $('#app');
// Until Firebase finishes loading, any tap that needs it gets a friendly message instead of an error.
const NOT_READY = new Proxy({}, { get: () => () => Promise.reject(new Error('Still connecting — try again in a second.')) });
let cloud = NOT_READY;
let unsubs = [];

/* ---------- data (Firebase) ---------- */
const readRaw = async (path) => {
  const r = await fetch(RAW + path + '?t=' + Date.now(), { cache: 'no-store' });
  return r.ok ? r.text() : null;
};
const withShared = (e, cals) => {
  if (e.pending) return { ...e, shared: false }; // waiting for Sam or Emily to approve: hidden from everyone else
  if (e.cal === 'friends') return { ...e, shared: true };
  const c = cals.find((x) => x.id === e.cal);
  return { ...e, shared: !!(c ? isShared(c) : false) && !e.private };
};

/** Apply a change to the calendar and save only what changed. */
async function saveCal(mutate) {
  if (!isEditor()) throw new Error('Sign in with Google to make changes.');
  const before = S.cal;
  const d = JSON.parse(JSON.stringify({ title: before.title, calendars: before.calendars, events: before.events, editors: before.editors || [] }));
  mutate(d);
  const spaceChanged = JSON.stringify([d.title, d.calendars, d.editors]) !== JSON.stringify([before.title, before.calendars, before.editors || []]);
  if (spaceChanged) await cloud.updateSpace(S.space, { title: d.title, calendars: d.calendars, editors: d.editors });
  const old = new Map(before.events.map((e) => [e.id, JSON.stringify(e)]));
  const puts = d.events.map((e) => withShared(e, d.calendars)).filter((e) => old.get(e.id) !== JSON.stringify(e));
  const keep = new Set(d.events.map((e) => e.id));
  const dels = before.events.filter((e) => !keep.has(e.id)).map((e) => e.id);
  await cloud.writeEvents(S.space, puts, dels);
  S.cal = { ...S.cal, ...d, events: d.events.map((e) => withShared(e, d.calendars)) };
  renderMain();
  return S.cal;
}

async function loadFeeds() {
  try {
    const t = await readRaw('data/feeds-space.enc');
    if (t) S.feeds = await decryptJSON(t, S.space);
  } catch {} // keep whatever we already had (e.g. the saved copy)
  saveSnap();
}

/* ---------- instant open: a saved copy of the last calendar shown on this device ---------- */
let snapTimer;
function saveSnap() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    if (!S.space || !S.cal) return;
    try { store.set('snap', JSON.stringify({ space: S.space, editor: S.editor, email: S.user?.email || '', cal: S.cal, feeds: S.feeds, rides: S.rides })); } catch {}
  }, 1000);
}
function paintFromSnap() {
  try {
    const s = JSON.parse(store.get('snap') || 'null');
    if (!s || !s.cal || !S.space || s.space !== S.space) return false;
    S.editor = !!s.editor; S.cal = s.cal; S.feeds = s.feeds || S.feeds; S.rides = s.rides || {};
    if (s.email) S.user = { email: s.email, name: '' };
    renderMain();
    return true;
  } catch { return false; }
}
async function loadInbox() {}

/* ---------- boot / sign-in ---------- */
// Home Screen app: works offline after the first visit.
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
addEventListener('offline', () => toast('No signal — showing the saved calendar', 4000));
addEventListener('online', () => toast('Back online', 2000));

async function boot() {
  const m = location.hash.match(/[#&]s=([\w-]{16,})/);
  if (m) { S.space = m[1]; store.set('space', m[1]); } // kept in the URL so a Home Screen icon opens straight to the calendar
  const painted = paintFromSnap(); // show the last calendar immediately, then bring it up to date
  try { cloud = await initCloud(); } catch { if (!painted) renderLanding('Couldn’t load. Check your internet connection and reload.'); return; }
  cloud.onUser(onUser);
}

async function onUser(u) {
  S.user = u;
  S.editor = false;
  if (u) {
    const known = store.get('editorSpace:' + u.email);
    if (known) {
      // Open right away; double-check in the background that this account is still an editor.
      S.editor = true; S.space = known;
      cloud.editorSpace(u.email).then((sp) => {
        if (sp === known) return;
        store.set('editorSpace:' + u.email, sp || null);
        store.set('snap', null); S.cal = null;
        onUser(u);
      }).catch(() => {});
      return start();
    }
    let space = null;
    try { space = await cloud.editorSpace(u.email); } catch {}
    if (space) { S.editor = true; S.space = space; store.set('space', space); store.set('editorSpace:' + u.email, space); return start(); }
    if (OWNERS.includes(u.email)) return renderMigrate();
    if (!S.space) return renderLanding(`${esc(u.email)} isn’t set up to edit this calendar yet. Ask Sam to add it in Settings → Editors.`);
    toast('This Google account can view but not edit — ask Sam to add you as an editor', 5000);
  }
  if (!u) {
    try { if (JSON.parse(store.get('snap') || 'null')?.editor) { store.set('snap', null); S.cal = null; } } catch {}
  }
  if (S.space) return start();
  renderLanding();
}

function renderLanding(msg = '') {
  unsubs.forEach((f) => f()); unsubs = [];
  app.innerHTML = `
  <div class="center"><div class="card">
    <h1>Family Calendar</h1>
    ${msg ? `<p class="help bad">${msg}</p>` : ''}
    <form id="codeForm">
      <label class="f">Family code</label>
      <input class="in" id="code" autocomplete="off" autocapitalize="words" placeholder="From Sam or Emily’s text">
      <div class="actions"><button class="btn primary big">Open the calendar</button></div>
    </form>
    <p class="help" style="margin-top:22px">Sam &amp; Emily: <a href="#" id="gsi">sign in with Google</a>.</p>
  </div></div>`;
  $('#gsi').onclick = (e) => { e.preventDefault(); cloud.signIn().catch((er) => toast(er.message, 6000)); };
  $('#codeForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#code').value.trim();
    if (!code) return;
    const sp = await cloud.lookupCode(code).catch(() => null);
    if (!sp) return toast('That code didn’t work — check the spelling', 4000);
    S.space = sp; store.set('space', sp);
    history.replaceState(null, '', location.pathname + '#s=' + sp); // so Add to Home Screen keeps it
    start();
  };
}

async function start() {
  unsubs.forEach((f) => f()); unsubs = [];
  const snap = S.cal; // already on screen from the saved copy, if any
  if (!snap) app.innerHTML = `<div class="center muted">Loading…</div>`;
  S.cal = { title: '', calendars: [], editors: [], events: [], ...(snap || {}) };
  let first = true;
  const paint = () => { saveSnap(); if ($('#modal').classList.contains('hidden')) renderMain(); else S.dirty = true; };
  // The space settings and the events load side by side (the phone's offline copy answers first).
  const spaceReady = new Promise((res) => {
    unsubs.push(cloud.watchSpace(S.space, (d, fromCache) => {
      if (!d) { if (fromCache) return; res(false); return; }
      Object.assign(S.cal, { title: d.title, calendars: d.calendars || [], editors: d.editors || [], familyCode: d.familyCode, codeSet: d.codeSet, choreLib: d.choreLib });
      res(true); if (!first) paint();
      if (S.listsOpen && S.listTab === 'board') drawLists();
    }, () => res(false)));
  });
  const eventsReady = new Promise((res) => {
    unsubs.push(cloud.watchEvents(S.space, !S.editor, (docs) => {
      S.cal.events = docs;
      if (first) { first = false; res(); } else paint();
    }, (err) => { toast('Couldn’t load events: ' + (err.code || err.message), 6000); res(); }));
  });
  unsubs.push(cloud.watchRides(S.space, (r) => { S.rides = r || {}; if (!first) paint(); }));
  if (S.editor) unsubs.push(cloud.watchItems(S.space, (items) => { S.itemsErr = items === null; S.items = items || []; if (S.listsOpen) drawLists(); }));
  if (!(await spaceReady)) {
    unsubs.forEach((f) => f()); unsubs = [];
    store.set('space', null); store.set('snap', null); S.space = null; S.cal = null;
    return renderLanding('That calendar link didn’t work. Ask Sam or Emily for a new one.');
  }
  await eventsReady;
  S.loadedAt = Date.now();
  paint();
  loadFeeds().then(() => { if ($('#modal').classList.contains('hidden')) renderMain(); else S.dirty = true; }); // team feeds fill in a moment later
}

function openSignIn() {
  const sh = openModal(`
    <div class="head"><div><h2>Sam or Emily?</h2><p class="help">Sign in with Google to add events, scan your email and import schedules.</p></div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="actions stack"><button class="btn primary big" id="gsi2">Sign in with Google</button></div>
    <p class="help">Everyone else: you can already see everything here${S.relative ? ' and add family events with + Add' : ''}.</p>`);
  $('[data-close]', sh).onclick = closeModal;
  $('#gsi2').onclick = () => { closeModal(); cloud.signIn().catch((e) => toast(e.message, 6000)); };
}

/* One-time move from the old GitHub-stored calendar into Firebase. */
function renderMigrate() {
  app.innerHTML = `
  <div class="center"><form class="card" id="mig">
    <h1>Move your calendar over</h1>
    <p class="help">One time only. Type your old family passcode and everything — events, attachments, calendars — moves into your Google-protected calendar. After this there are no passcodes or tokens.</p>
    <label class="f">Old family passcode</label>
    <input class="in" id="oldPass" type="password" required autocomplete="current-password">
    <label class="f">Emily’s Gmail (she’ll be an editor too)</label>
    <input class="in" id="emily" type="email" value="erahlersmeyer@gmail.com">
    <p class="bad help" id="err"></p>
    <div class="actions"><button class="btn primary big">Move it over</button></div>
  </form></div>`;
  $('#mig').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#mig button'); btn.disabled = true; btn.textContent = 'Moving…';
    try {
      const raw = await readRaw('data/calendar.enc');
      if (!raw) throw new Error('Couldn’t find the old calendar.');
      let old;
      try { old = await decryptJSON(raw, $('#oldPass').value.trim()); } catch { throw new Error('That passcode didn’t work.'); }
      const space = old.spaceId || [...crypto.getRandomValues(new Uint8Array(18))].map((b) => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join('');
      const editors = [...new Set([S.user.email, ...OWNERS.filter((e) => e === S.user.email), $('#emily').value.trim().toLowerCase()].filter(Boolean))];
      const calendars = old.calendars.map((c) => ({ ...c, shared: isShared(c) }));
      let events = old.events.slice();
      // relatives' events from the old inbox repo, if any
      if (old.inbox?.token && old.relativesPass) {
        try {
          const r = await fetch(`https://api.github.com/repos/${old.inbox.repo}/contents/inbox.enc`, { headers: { Authorization: 'Bearer ' + old.inbox.token, Accept: 'application/vnd.github+json' } });
          if (r.ok) { const j = await r.json(); const ib = await decryptJSON(decodeURIComponent(escape(atob(j.content.replace(/\s/g, '')))), old.relativesPass); events.push(...(ib.events || []).map((e) => ({ ...e, cal: 'friends' }))); }
        } catch {}
      }
      btn.textContent = `Moving ${events.length} events…`;
      await cloud.createSpace(space, { title: old.title || 'Family Calendar', owner: S.user.email, editors, calendars, createdAt: Date.now() });
      for (const e of editors) await cloud.setEditor(e, space);
      try { await cloud.setCode(old.relativesPass || 'Ahlersmeyer', space); await cloud.updateSpace(space, { familyCode: old.relativesPass || 'Ahlersmeyer', codeSet: true }); } catch {}
      await cloud.writeEvents(space, events.map((e) => withShared(e, calendars)));
      S.space = space; S.editor = true; store.set('space', space);
      await start();
      toast(`Moved ${events.length} events ✓`, 4000);
    } catch (err) { btn.disabled = false; btn.textContent = 'Move it over'; $('#err').textContent = err.message; }
  };
}

/* ---------- events ---------- */
const FRIENDS = { id: 'friends', name: 'Family & Friends', color: '#0891b2', shared: true };
const calById = (id) => S.cal.calendars.find((c) => c.id === id) || (id === 'friends' ? FRIENDS : { id, name: 'Other', color: '#94a3b8' });
const visibleCalendars = () => [...(isEditor() ? S.cal.calendars : S.cal.calendars.filter(isShared)), FRIENDS];

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.82;
}
const swatch = (c) => `background:${esc(c)};${isLight(c) ? 'box-shadow:inset 0 0 0 1.5px var(--muted);' : ''}`;

/* kids: "show me only Theo" (helpers in lib/events.js) */
const kidsList = () => S.cal.kids || KIDS;
const calKid = (c) => calKidOf(c, kidsList());
const titleKid = (t) => titleKidOf(t, kidsList());
const eventKid = (e) => calKid(calById(e.cal)) || titleKid(e.title);
const forKid = (e, k) => forKidOf(e, k, calById(e.cal), kidsList());

/* practices: Sam & Emily see them; relatives don't unless they switch them on (per device) */
const showPractices = () => { const v = store.get('practices'); return v === null ? isEditor() : v === '1'; };

/* repeating events: lib/events.js */
const repeatLabel = (r) => (r && REPEATS[r.every] ? REPEATS[r.every] + (r.until ? ` until ${fmtDay(r.until)}` : '') : '');
const MAYBE_RE = /^\s*(maybe\b|if\b|possible\b)|\bif (they|we|he|she) (win|lose|advance|qualify)/i;

/* who's driving */
const rideKey = (id) => String(id).replace(/\//g, '_');
const rideFor = (e) => S.rides[rideKey(e.id)];
const myName = () => store.get('myName') || (S.user?.name || '').split(' ')[0] || '';

/* two kids in two places at once */
function overlapMap(evs) {
  const out = { __dups: dupMap(evs) };
  const timed = evs.filter((e) => !e.allDay && !e.maybe);
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
    const a = timed[i], b = timed[j];
    const ae = a.end || addMinutes(a.start, 60), be = b.end || addMinutes(b.start, 60);
    if (!(a.start < be && b.start < ae)) continue;
    const ka = eventKid(a), kb = eventKid(b);
    if (!ka || !kb || ka === kb) continue;
    if (out.__dups[a.id] || out.__dups[b.id]) continue;
    out[a.id] ||= b.title; out[b.id] ||= a.title;
  }
  return out;
}

/* duplicate guard: same day, about the same time, sharing a real word in the title */
const STOP = new Set(['the', 'and', 'game', 'games', 'lutheran', 'school', 'church', 'with', 'for', 'max', 'theo', 'junie', 'louie', 'josie', 'holy', 'cross', 'crusaders', 'mad', 'apples', '14u', 'maybe', 'they', 'win', 'lose', 'day']);
const PLACE_STOP = new Set(['street', 'ave', 'avenue', 'road', 'blvd', 'drive', 'fort', 'wayne', 'indianapolis', 'gym', 'north', 'south', 'east', 'west']);
const stem = (w) => w.replace(/(ings?|ed|es|s)$/, '');
const words = (t) => String(t || '').toLowerCase().replace(/\(.*?\)|\bvs\.?|@|–|-/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
// what an event is about: its title plus the name of the place (not the street address)
const about = (e) => new Set([...words(e.title), ...words(String(e.location || '').split(',')[0]).filter((w) => !PLACE_STOP.has(w))]);
function findDuplicate(c, ignoreId) {
  const d = c.start.slice(0, 10);
  const cw = about(c);
  const pool = allEvents({ everything: true }); // look across everyone, even when a kid filter is on
  return pool.find((e) => {
    if ((ignoreId && (e.id === ignoreId || e.seriesId === ignoreId)) || e.start.slice(0, 10) !== d) return false;
    if (e.title.trim().toLowerCase() === c.title.trim().toLowerCase()) return true;
    const near = c.allDay || e.allDay ? c.allDay === e.allDay : Math.abs(diffMinutes(e.start, c.start)) <= 45;
    return near && [...about(e)].some((w) => cw.has(w));
  });
}

/* the same thing entered twice (by hand and from email, say): flag the newer copy so an editor can delete it */
function dupMap(evs) {
  const out = {};
  if (!isEditor()) return out;
  const mine = evs.filter((e) => !e.allDay && e.source !== 'feed' && !e.seriesId);
  for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
    const a = mine[i], b = mine[j];
    if (Math.abs(diffMinutes(a.start, b.start)) > 45) continue;
    const wa = about(a);
    if (a.title.trim().toLowerCase() !== b.title.trim().toLowerCase() && ![...about(b)].some((w) => wa.has(w))) continue;
    const newer = (b.source === 'email' && a.source !== 'email') || (b.createdAt || 0) > (a.createdAt || 0) ? b : a;
    out[newer.id] = newer === a ? b : a;
  }
  return out;
}

function allEvents({ everything = false } = {}) {
  const practices = everything || showPractices();
  const seen = new Set();
  const out = [];
  // Team-feed games that match an event already on the calendar are merged into it (lib/events.js).
  const { merged, feeds } = mergeFeeds(S.cal.events, S.feeds.events);
  const live = new Set(S.cal.events.map((e) => e.id));
  const myWaiting = isEditor() ? [] : JSON.parse(store.get('myPending') || '[]').filter((e) => !live.has(e.id) && (e.end || e.start) >= todayWall());
  for (const e0 of [...S.cal.events.filter((e) => !e.pending).flatMap(occurrences), ...myWaiting, ...feeds, ...(S.inbox.events || [])]) {
    const e = merged.get(e0.id) || e0;
    if (seen.has(e.id) || S.hidden.has(e.cal)) continue;
    if (!everything && S.kid && !forKid(e, S.kid)) continue;
    if (!practices && kindOf(e) === 'practice') continue;
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
    .filter((e) => !e.maybe && !/no school|no indoor|break\b/i.test(e.title))
    .sort((a, b) => a.start.localeCompare(b.start))[0];
}

function whoChip(c) {
  return `<span class="who"><i style="${swatch(c.color)}"></i>${esc(c.name)}</span>`;
}

/** "Holy Cross Lutheran School, 3425 Crescent Ave, Fort Wayne" → "Holy Cross" (the full address stays in the event). */
function shortPlace(loc) {
  let seg = String(loc || '').split(/\n|,| — | – | \(/)[0].trim();
  if (!seg) return '';
  if (/^\d/.test(seg)) return seg; // a street address: keep "4141 N Clinton St"
  seg = seg.replace(/^Allen County War Memorial\s+/i, '')
    .replace(/\s+(Evangelical\s+)?(Lutheran|Catholic|Christian|Community|Methodist|Baptist)?\s*(High School|Middle School|Elementary School|Elementary|Grade School|School|Church|Academy|Parish)$/i, '')
    .trim();
  return seg || loc;
}

function evRow(e, ov = {}) {
  const c = calById(e.cal);
  const ride = rideFor(e);
  const t = e.allDay ? 'All day' : fmtTime(e.start);
  const end = !e.allDay && e.end && e.end.slice(0, 10) === e.start.slice(0, 10) ? fmtTime(e.end) : '';
  return `<div class="ev ${e.maybe ? 'maybe' : ''}" role="button" tabindex="0" data-ev="${esc(e.id)}"><span class="bar" style="${swatch(c.color)}"></span>
    <span class="t">${t}${end ? `<small>to ${end}</small>` : ''}</span>
    <span class="b"><b>${e.pending ? '<span class="tag">Waiting for OK</span> ' : ''}${e.maybe ? '<span class="tag">Maybe</span> ' : ''}${e.private && !S.relative ? '<span class="lock" title="Only you two">🔒</span> ' : ''}${esc(e.title)}${e.repeat ? ' <span class="rep" title="Repeats">🔁</span>' : ''}</b>
      ${whoChip(c)}
      ${e.location ? `<a class="where" href="${mapsUrl(e.location)}" target="_blank" rel="noopener" data-stop title="${esc(e.location)}">📍 ${esc(shortPlace(e.location))}</a>` : ''}
      ${ride ? `<small class="ride">🚗 ${esc(ride.driver)} driving</small>` : ''}
      ${ov.__dups?.[e.id] ? `<small class="warn">♊ Looks like a duplicate of “${esc(ov.__dups[e.id].title)}”</small>` : ov[e.id] ? `<small class="warn">⚠️ Same time as ${esc(ov[e.id])}</small>` : ''}
      ${e.addedBy ? `<small class="muted">Added by ${esc(e.addedBy)}</small>` : ''}</span></div>`;
}

/* ---------- main screen ---------- */
function renderMain() {
  const family = isEditor();
  const canAdd = isEditor() || canFamilyAdd();
  const day = () => (S.view === 'month' ? S.day : S.view === 'week' && S.week && S.week > todayWall() ? S.week : todayWall());
  app.innerHTML = `
  <header class="top">
    <div class="row1">
      <div class="brand">${esc(S.cal.title || 'Family Calendar')}</div>
      <button class="btn icon ghost" id="searchBtn" aria-label="Search">🔍</button>
    </div>
    ${S.q !== undefined ? `<div class="searchbar"><input class="in" id="q" type="search" placeholder="Search events, places, notes…" value="${esc(S.q)}" autocomplete="off"><button class="btn" id="qx">Done</button></div>` : ''}
    <div class="row2">
      <div class="seg"><button data-view="list" class="${S.view === 'list' ? 'on' : ''}">Upcoming</button><button data-view="week" class="${S.view === 'week' ? 'on' : ''}">Week</button><button data-view="month" class="${S.view === 'month' ? 'on' : ''}">Month</button></div>
      <button class="kid prac ${showPractices() ? 'on' : ''}" id="pracBtn" aria-pressed="${showPractices()}" title="Show or hide practices and workouts">${showPractices() ? '✓ ' : ''}Practices</button>
    </div>
  </header>
  ${welcomeBanner()}
  ${(() => { const n = isEditor() ? S.cal.events.filter((e) => e.pending).length : 0; return n ? `<button class="welcome approve" id="approvals"><div><b>📬 ${n} event${n === 1 ? '' : 's'} from family to OK</b><br><span class="help">Tap to approve or decline</span></div></button>` : ''; })()}
  <nav class="kids" aria-label="Whose schedule">${['', ...kidsList()].map((k) => `<button class="kid ${S.kid === k ? 'on' : ''}" data-kid="${esc(k)}">${k ? esc(k) : 'Everyone'}</button>`).join('')}</nav>
  <nav class="chips" aria-label="Show or hide calendars">${visibleCalendars().map((c) => `<button class="chip ${S.hidden.has(c.id) ? 'off' : ''}" data-cal="${esc(c.id)}"><i style="${swatch(c.color)}"></i>${esc(c.name)}</button>`).join('')}</nav>
  <main id="view"></main>
  <nav class="tabbar" aria-label="Menu">
    <button data-tab="cal"><span>📅</span>Calendar</button>
    <button data-tab="add" class="addtab"><span>＋</span>Add</button>
    ${family ? `<button data-tab="lists"><span>🛒</span>Lists</button><button data-tab="email"><span>✉️</span>Email</button><button data-tab="import"><span>📄</span>Import</button>` : ''}
    <button data-tab="settings"><span>⚙️</span>Settings</button>
  </nav>`;
  $$('[data-view]').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; store.set('view', S.view); renderMain(); }));
  if ($('#approvals')) $('#approvals').onclick = openApprovals;
  $('#searchBtn').onclick = () => { S.q = S.q === undefined ? '' : undefined; renderMain(); if (S.q !== undefined) $('#q').focus(); };
  if ($('#q')) {
    $('#q').oninput = () => { S.q = $('#q').value; renderSearch(); };
    $('#qx').onclick = () => { S.q = undefined; renderMain(); };
  }
  $$('[data-kid]').forEach((b) => (b.onclick = () => { S.kid = b.dataset.kid; store.set('kid', S.kid || null); renderMain(); }));
  $('#pracBtn').onclick = () => {
    const on = !showPractices();
    store.set('practices', on === isEditor() ? null : on ? '1' : '0'); // back to the default if it matches
    renderMain(); toast(on ? 'Showing practices' : 'Practices hidden — games, programs, church and school only');
  };
  $$('[data-cal]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.cal;
    S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
    store.set('hidden', JSON.stringify([...S.hidden]));
    renderMain();
  }));
  if ($('#welcomeX')) $('#welcomeX').onclick = () => { store.set(S.relative ? 'welcomedRel' : 'welcomedEd', '1'); renderMain(); };
  const needEditor = (fn) => () => (isEditor() ? fn() : openSignIn());
  const actions = {
    cal: () => { if (S.view !== 'list') { S.view = 'list'; store.set('view', 'list'); renderMain(); } scrollTo({ top: 0, behavior: 'smooth' }); },
    add: () => (isEditor() ? openEdit(null, day()) : openFamilyAdd(day())),
    lists: needEditor(() => openLists()),
    email: needEditor(() => openImport(null, 'email')),
    import: needEditor(() => openImport()),
    settings: openSettings,
  };
  $$('[data-tab]', $('.tabbar')).forEach((b) => (b.onclick = () => actions[b.dataset.tab]()));
  if (S.q) return renderSearch();
  S.view === 'month' ? renderMonth() : S.view === 'week' ? renderWeek() : renderList();
}

function welcomeBanner() {
  if (S.relative && !store.get('welcomedRel')) return `<div class="welcome"><div><b>Welcome! 👋</b> These are the Ahlersmeyer kids’ games, concerts, church and school events. Want practices too? Tap <b>Practices</b> above.
    Tap any event for the time, place and directions.${canFamilyAdd() ? ' Tap <b>+ Add</b> to put your own family event on the calendar.' : ''}
    ${isApple ? ' Tip: tap <b>Share → Add to Home Screen</b> to keep it one tap away.' : ''}</div><button class="btn icon ghost" id="welcomeX" aria-label="Got it">✕</button></div>`;
  if (!S.relative && isEditor() && !store.get('welcomedEd')) return `<div class="welcome"><div><b>You’re an editor.</b> Tap <b>+ Add</b> for a new event, <b>✉︎ Email</b> to pull events from your Gmail, or <b>Import</b> to drop in a schedule PDF.
    Relatives see everything except the <b>Family</b> calendar and anything marked 🔒, and practices are hidden for them unless they tap <b>Practices</b>.</div><button class="btn icon ghost" id="welcomeX" aria-label="Got it">✕</button></div>`;
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
    ${(() => { const ov = overlapMap(idx[d]); return idx[d].map((e) => evRow(e, ov)).join(''); })()}</section>`;
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
  const ov = overlapMap(evs);
  $('#daylist').innerHTML = `<h3><span class="rel">${esc(dayLabel(S.day))}</span><span>${dateLine(S.day)}</span></h3>${evs.length ? evs.map((e) => evRow(e, ov)).join('') : '<p class="muted">Nothing this day.</p>'}`;
  bindEvents($('#daylist'));
}

/* search: everything from 60 days ago on — titles, places, notes, calendar names, who added it */
function renderSearch() {
  const view = $('#view');
  if (!S.q || !S.q.trim()) { S.view === 'month' ? renderMonth() : S.view === 'week' ? renderWeek() : renderList(); return; }
  const terms = S.q.toLowerCase().split(/\s+/).filter(Boolean);
  const from = addDays(todayWall(), -60);
  const hits = allEvents().filter((e) => e.start.slice(0, 10) >= from).filter((e) => {
    const hay = `${e.title} ${e.location || ''} ${e.notes || ''} ${calById(e.cal).name} ${e.addedBy || ''} ${rideFor(e)?.driver || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 150);
  if (!hits.length) { view.innerHTML = `<div class="empty"><p><b>No matches for “${esc(S.q)}”.</b></p><p class="muted">Searches titles, places, notes and calendar names.</p></div>`; return; }
  const today = todayWall();
  let last = '';
  view.innerHTML = `<section class="day"><p class="help">${hits.length} match${hits.length === 1 ? '' : 'es'}</p>` + hits.map((e) => {
    const d = e.start.slice(0, 10);
    const h = d !== last ? `<h3 class="${d < today ? 'muted' : ''}"><span class="rel">${esc(dayLabel(d))}</span><span>${dayLabel(d) === fmtDay(d) ? '' : esc(MONTHS[+d.slice(5, 7) - 1] + ' ' + +d.slice(8) + (d.slice(0, 4) !== today.slice(0, 4) ? ', ' + d.slice(0, 4) : ''))}</span></h3>` : '';
    last = d;
    return h + evRow(e);
  }).join('') + '</section>';
  bindEvents(view);
}

function renderWeek() {
  const view = $('#view');
  const today = todayWall();
  S.week ||= addDays(today, -dow(today));
  const days = Array.from({ length: 7 }, (_, i) => addDays(S.week, i));
  const idx = indexByDay(days[0], days[6]);
  const md = (d) => `${MONTHS[+d.slice(5, 7) - 1].slice(0, 3)} ${+d.slice(8)}`;
  view.innerHTML = `
    <div class="monthbar">
      <button class="btn icon" id="prev" aria-label="Previous week">‹</button>
      <h2>${md(days[0])} – ${md(days[6])}</h2>
      <button class="btn" id="today">This week</button>
      <button class="btn icon" id="next" aria-label="Next week">›</button>
    </div>
    <div class="week">${days.map((d) => {
      const evs = idx[d] || [];
      const ov = overlapMap(evs);
      return `<section class="day wday ${d === today ? 'today' : ''} ${d < today ? 'past' : ''}"><h3><span class="rel">${d === today ? 'Today' : WEEKDAYS[dow(d)]}</span><span>${md(d)}</span></h3>
        ${evs.length ? evs.map((e) => evRow(e, ov)).join('') : '<p class="muted nothing">Nothing planned</p>'}</section>`;
    }).join('')}</div>`;
  $('#prev').onclick = () => { S.week = addDays(S.week, -7); renderWeek(); };
  $('#next').onclick = () => { S.week = addDays(S.week, 7); renderWeek(); };
  $('#today').onclick = () => { S.week = addDays(today, -dow(today)); renderWeek(); };
  bindEvents(view);
}

/* ---------- modal ---------- */
function openModal(html) {
  $('#sheet').innerHTML = html;
  $('#modal').classList.remove('hidden');
  return $('#sheet');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#sheet').innerHTML = ''; S.listsOpen = false; }
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
    ...(e.allDay ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(e.title)}`, 'TRIGGER:-PT30M', 'END:VALARM']),
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
  const series = e.seriesId && S.cal.events.find((x) => x.id === e.seriesId);
  const ride = rideFor(e);
  const canDelete = canEdit || (fromFamily && isEditor());
  const sh = openModal(`
    <div class="head"><div><h2>${esc(e.title)}</h2>${whoChip(c)}</div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="meta big">
      <div><span class="k">When</span><b>${['Today', 'Tomorrow'].includes(dayLabel(d)) ? esc(dayLabel(d)) + ' · ' : ''}${esc(dateLine(d))}</b><br>${esc(timeRange(e))}</div>
      ${e.location ? `<div><span class="k">Where</span><b>${esc(e.location)}</b></div>` : ''}
      ${e.notes ? `<div class="notes">${esc(e.notes)}</div>` : ''}
      ${e.addedBy ? `<div class="help">Added by ${esc(e.addedBy)}</div>` : ''}
      ${e.private && !S.relative ? `<div class="help">🔒 Only you two — extended family doesn’t see this</div>` : ''}
      ${isEditor() && kindOf(e) === 'practice' && !e.private ? `<div class="help">🏃 Practice — extended family only sees it if they switch practices on</div>` : ''}
      ${fromFeed ? `<div class="help">Synced from the team’s calendar — changes come from the team app.</div>` : ''}
      ${(() => { const d = isEditor() && dupMap((indexByDay(e.start.slice(0, 10), e.start.slice(0, 10))[e.start.slice(0, 10)] || []))[e.id]; return d ? `<div class="help bad">♊ Looks like the same thing as “${esc(d.title)}” (${esc(timeRange(d))}). If so, delete this one.</div>` : ''; })()}
      ${e.pending ? `<div class="help">⏳ Waiting for Sam or Emily to OK it — only you can see it for now.</div>` : ''}
      ${e.maybe ? `<div class="help">❔ <b>Maybe</b> — depends on results. ${isEditor() ? 'Delete it if it doesn’t happen.' : ''}</div>` : ''}
      ${e.repeat ? `<div class="help">🔁 ${esc(repeatLabel(e.repeat))}</div>` : ''}
      ${!e.allDay ? `<div class="ridebox" id="ridebox"><span class="k">Who’s driving?</span>
        ${ride ? `<div class="two"><b class="driver">🚗 ${esc(ride.driver)}</b><button class="btn" id="rideClear">Not anymore</button></div>`
          : `<div class="two"><input class="in" id="rideName" value="${esc(myName())}" placeholder="Your name" autocomplete="name"><button class="btn" id="rideMe">🙋 I’ll drive</button></div>`}</div>` : ''}
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
  const setRide = async (data) => {
    try { await cloud.setRide(S.space, rideKey(e.id), data); S.rides = { ...S.rides }; if (data) S.rides[rideKey(e.id)] = data; else delete S.rides[rideKey(e.id)]; openDetail(id); S.dirty = true; toast(data ? `Thanks, ${data.driver}!` : 'Cleared'); }
    catch (err) { toast(/permission/i.test(err.code || err.message) ? 'Driving sign-up isn’t switched on yet — Sam needs to update the database rules.' : err.message, 6000); }
  };
  if ($('#rideMe')) $('#rideMe').onclick = () => {
    const n = $('#rideName').value.trim();
    if (!n) return $('#rideName').focus();
    store.set('myName', n);
    setRide({ driver: n.slice(0, 50), at: Date.now() });
  };
  if ($('#rideClear')) $('#rideClear').onclick = () => setRide(null);
  if (canEdit) $('#edit').onclick = () => openEdit(series || e);
  if (canDelete && series) $('#del').onclick = () => {
    const box = $('#del').parentElement;
    box.innerHTML = `<p class="help" style="width:100%">This repeats. Delete which?</p><button class="btn danger" id="delOne">Just ${esc(fmtDay(e.occ))}</button><button class="btn danger" id="delAll">Every one</button><button class="btn" id="delNo">Cancel</button>`;
    $('#delNo').onclick = () => openDetail(id);
    $('#delOne').onclick = async () => {
      try { await saveCal((d) => { const b = d.events.find((x) => x.id === series.id); if (b) b.repeat = { ...b.repeat, skip: [...new Set([...(b.repeat.skip || []), e.occ])] }; }); closeModal(); toast('Deleted that one'); }
      catch (err) { toast(err.message, 5000); }
    };
    $('#delAll').onclick = async () => {
      try { await saveCal((d) => { d.events = d.events.filter((x) => x.id !== series.id); }); closeModal(); toast('Deleted the whole series'); }
      catch (err) { toast(err.message, 5000); }
    };
  };
  else if (canDelete) $('#del').onclick = async () => {
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
const ATT_MAX = 5 * 1024 * 1024;
async function uploadAttachment(file) {
  if (file.size > ATT_MAX) throw new Error(`${file.name} is too big (5 MB max)`);
  const id = newId();
  await cloud.putFile(S.space, id, { name: file.name, type: file.type || 'application/pdf', size: file.size }, bytesToB64(new Uint8Array(await file.arrayBuffer())));
  return { name: file.name.replace(/\.[^.]+$/, ''), path: 'fs:' + id, type: file.type || 'application/pdf' };
}
async function openAttachment(a) {
  const win = window.open('', '_blank'); // open now so phones don't block it
  try {
    if (win) win.document.write('<p style="font:16px system-ui;padding:20px">Opening…</p>');
    let bytes;
    if (a.path.startsWith('fs:')) bytes = Uint8Array.from(atob(await cloud.getFile(S.space, a.path.slice(3))), (c) => c.charCodeAt(0));
    else {
      const r = await fetch(RAW + a.path, { cache: 'force-cache' });
      if (!r.ok) throw new Error('Couldn’t load the file (' + r.status + ')');
      bytes = await decryptBytes(await r.arrayBuffer(), a.key);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: a.type }));
    if (win) win.location.href = url; else location.href = url;
  } catch (err) { if (win) win.close(); toast(err.message, 5000); }
}

/* ---------- approve what relatives add ---------- */
function openApprovals() {
  const list = S.cal.events.filter((e) => e.pending).sort((a, b) => a.start.localeCompare(b.start));
  const sh = openModal(`
    <div class="head"><div><h2>From family</h2><p class="help">Nobody else sees these until you OK them.</p></div><button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    ${list.length ? list.map((e) => `<div class="mail" data-id="${esc(e.id)}"><div class="mailhead"><b>${esc(e.title)}</b><small>Added by ${esc(e.addedBy || 'someone')}</small></div>
      <div class="help">${esc(dateLine(e.start.slice(0, 10)))} · ${esc(timeRange(e))}${e.location ? ' · ' + esc(e.location) : ''}</div>
      ${e.notes ? `<div class="help">${esc(e.notes)}</div>` : ''}
      <div class="actions"><button class="btn primary" data-ok>✓ Add to calendar</button><button class="btn danger" data-no>Decline</button></div></div>`).join('') : '<p class="muted">All caught up.</p>'}`);
  $('[data-close]', sh).onclick = closeModal;
  $$('.mail', sh).forEach((box) => {
    const id = box.dataset.id;
    $('[data-ok]', box).onclick = async () => {
      try { await saveCal((d) => { const ev = d.events.find((x) => x.id === id); if (ev) delete ev.pending; }); box.remove(); toast('Added for everyone'); if (!$$('.mail', sh).length) { closeModal(); } }
      catch (err) { toast(err.message, 5000); }
    };
    $('[data-no]', box).onclick = async () => {
      try { await saveCal((d) => { d.events = d.events.filter((x) => x.id !== id); }); box.remove(); toast('Declined'); if (!$$('.mail', sh).length) { closeModal(); } }
      catch (err) { toast(err.message, 5000); }
    };
  });
}

/* ---------- relatives add events (Family & Friends) ---------- */
const familyAddOn = () => !!S.space;
const canFamilyAdd = () => !isEditor() && !!S.space;
async function saveInbox(mutate) {
  await saveCal((d) => {
    const fr = { events: d.events.filter((e) => e.cal === 'friends') };
    mutate(fr);
    d.events = [...d.events.filter((e) => e.cal !== 'friends'), ...fr.events.map((e) => ({ ...e, cal: 'friends' }))];
  });
}

function openFamilyAdd(day) {
  const name = store.get('myName') || '';
  const sh = openModal(`
    <div class="head"><div><h2>Add a family event</h2><p class="help">Birthdays, dinners, visits, anything. Sam or Emily will give it a quick OK, then everyone sees it.</p></div>
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
      await cloud.addFamilyEvent(S.space, { ...e, cal: 'friends', shared: false, pending: true, createdAt: Date.now() });
      store.set('myPending', JSON.stringify([...JSON.parse(store.get('myPending') || '[]'), { ...e, cal: 'friends', pending: true }].slice(-50)));
      store.set('myAdds', JSON.stringify([...JSON.parse(store.get('myAdds') || '[]'), e.id].slice(-300)));
      closeModal(); toast('Sent! It’ll show for everyone once Sam or Emily OKs it.', 5000); renderMain();
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
      <label class="dropzone smart" id="smartZone"><input type="file" id="smartFile" accept=".ics,.ical,.pdf,image/*,text/calendar" hidden>
        <b>📎 Drop or choose a flyer, PDF, screenshot or invite</b><br><span class="help">I’ll read it and fill in the details below</span></label>
      ${isNew ? `<button type="button" class="btn" id="pasteBtn" style="width:100%;margin-top:8px">📋 Paste a screenshot or text</button>
      <div id="pasteBox" class="hidden"><textarea class="in" id="pasteText" style="min-height:90px;margin-top:8px" placeholder="Paste the email or message here"></textarea>
        <div class="actions" style="margin-top:6px"><button type="button" class="btn primary" id="pasteGo">Fill it in</button></div></div>` : ''}
      <div id="smartStatus" class="help"></div>
      <label class="f">What</label><input class="in" name="title" value="${esc(e.title)}" required placeholder="${isNew ? 'e.g. Theo practice Thu 6pm at Mad Apple' : 'e.g. Theo practice'}">
      ${isNew ? '<p class="help">Type it like you’d text it — a day, time or “at” place fills in the boxes below.</p>' : ''}
      <div class="two"><div><label class="f">Calendar</label><select class="in" name="cal">${calOptions(e.cal)}</select></div>
        <div><label class="f">Type</label><select class="in" name="kind"><option value="">${esc(KINDS[kindOf({ title: e.title })])} (guess)</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div></div>
      <p class="help">Practices are hidden from extended family unless they switch them on.</p>
      <div class="two"><div><label class="f">Date</label><input class="in" type="date" name="date" value="${d}" required></div>
        <div class="alld ${e.allDay ? '' : 'hidden'}"><label class="f">Through</label><input class="in" type="date" name="last" value="${lastDay}"></div></div>
      <label class="check"><input type="checkbox" name="allDay" ${e.allDay ? 'checked' : ''}> All day</label>
      <label class="check"><input type="checkbox" name="priv" ${e.private ? 'checked' : ''}> Only us (hide from extended family)</label>
      <p class="help">The Family calendar is always just you two. Sports, school and church calendars are shared with relatives unless you check this.</p>
      <div class="two timed ${e.allDay ? 'hidden' : ''}"><div><label class="f">Starts</label><input class="in" type="time" name="st" value="${e.allDay ? '18:00' : e.start.slice(11, 16)}"></div>
        <div><label class="f">Ends</label><input class="in" type="time" name="et" value="${!e.allDay && e.end ? e.end.slice(11, 16) : ''}"></div></div>
      <div class="two"><div><label class="f">Repeats</label><select class="in" name="rep"><option value="">Doesn’t repeat</option>${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}" ${e.repeat?.every === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="untilw ${e.repeat ? '' : 'hidden'}"><label class="f">Until <span class="muted">(optional)</span></label><input class="in" type="date" name="until" value="${e.repeat?.until || ''}"></div></div>
      ${e.repeat ? '<p class="help">Changes apply to every repeat.</p>' : ''}
      <label class="check"><input type="checkbox" name="maybe" ${e.maybe ? 'checked' : ''}> Maybe — depends on results (e.g. “if they win”)</label>
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
  const pending = []; // files read by the drop zone get attached on save
  const showNew = () => { $('#newatts').textContent = [...pending, ...f.files.files].map((x) => '📎 ' + x.name).join('  '); };
  f.files.onchange = showNew;
  $('#smartFile').onchange = (ev) => { if (ev.target.files[0]) smartFill(ev.target.files[0], f, pending, showNew); };
  f._smart = (file) => smartFill(file, f, pending, showNew);
  if (isNew) {
    const status = (t, bad) => { const el = $('#smartStatus'); el.textContent = t; el.classList.toggle('bad', !!bad); };
    const fromPaste = (t) => {
      if (!t.trim()) return status('Nothing to read — paste the email or message first.', true);
      $('#pasteBox').classList.add('hidden');
      fillFromText(t, f, status, 'what you pasted');
      if (!f.notes.value.trim() || f.notes.value === t.replace(/\s+/g, ' ').trim().slice(0, 500)) f.notes.value = t.trim().slice(0, 1500);
    };
    $('#pasteBtn').onclick = async () => {
      // Try the clipboard straight away (iPhone shows a small "Paste" bubble); fall back to a box to paste into.
      const c = await readClipboard();
      if (c.file) { $('#pasteBox').classList.add('hidden'); return smartFill(c.file, f, pending, showNew); }
      const t = c.text || '';
      if (t.trim().length > 8) return fromPaste(t);
      $('#pasteBox').classList.remove('hidden'); $('#pasteText').focus();
    };
    $('#pasteGo').onclick = () => fromPaste($('#pasteText').value);
    // a picture pasted into the box (long-press → Paste) gets read too
    $('#pasteText').addEventListener('paste', (ev) => { const img = pastedImage(ev); if (img) { ev.preventDefault(); $('#pasteBox').classList.add('hidden'); smartFill(img, f, pending, showNew); } });
    // "Andrew Peterson concert Fri Dec 4 7:30pm at Blue Gate" → title, date, time and place
    let touched = false;
    f.date.addEventListener('input', () => (touched = true));
    f.title.addEventListener('change', () => {
      const q = quickParse(f.title.value, f.date.value);
      if (!q) return;
      if (q.title) f.title.value = q.title;
      if (q.date && !touched) { f.date.value = q.date; if (f.last) f.last.value = q.date; }
      if (q.time) { f.allDay.checked = false; f.allDay.onchange(); f.st.value = q.time; f.et.value = q.endTime || ''; }
      if (q.location && !f.location.value) f.location.value = q.location;
      f.title.dispatchEvent(new Event('input'));
      const g = guessCalText(f.title.value); if (g !== 'family' && [...f.cal.options].some((o) => o.value === g)) f.cal.value = g;
      status(`✓ ${new Date(f.date.value + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${q.time ? ' at ' + fmtHM(q.time) : ''}${q.location ? ' · ' + q.location : ''} — check it and tap Save.`);
    });
  }
  // keep the "(guess)" label in step with the title
  f.title.addEventListener('input', () => { f.kind.options[0].textContent = KINDS[kindOf({ title: f.title.value })] + ' (guess)'; });
  f.rep.onchange = () => $('.untilw', f).classList.toggle('hidden', !f.rep.value);
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
    const out = { ...e, createdAt: e.createdAt || Date.now(), id: e.id || newId(), cal: f.cal.value, title: f.title.value.trim(), allDay, start, end, location: f.location.value.trim(), notes: f.notes.value.trim(), source: e.source || 'manual' };
    if (f.kind.value) out.kind = f.kind.value; else delete out.kind;
    if (f.priv.checked) out.private = true; else delete out.private;
    if (f.maybe.checked) out.maybe = true; else delete out.maybe;
    if (f.rep.value) out.repeat = { every: f.rep.value, ...(f.until.value ? { until: f.until.value } : {}), skip: (e.repeat?.skip || []).filter((d) => d >= date) };
    else delete out.repeat;
    delete out.seriesId; delete out.occ;
    store.set('lastCal', out.cal);
    const btn = $('button.primary', f);
    const dup = isNew && !f.dataset.dupOk && findDuplicate(out);
    if (dup) {
      f.dataset.dupOk = '1';
      $('#smartStatus').innerHTML = `<b class="bad">Looks like this is already on the calendar:</b> ${esc(dup.title)} · ${esc(timeRange(dup))}. Tap Save again to add it anyway.`;
      $('#smartStatus').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const added = [];
      for (const file of [...pending, ...f.files.files]) {
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

/* A printed month calendar photo: use where each word sits. Each note belongs to the day number
   just above it in the same box, so "Piano 4pm" under "17" becomes "Nov 17 Piano 4pm". */
function gridFromOcr(d) {
  const m = (d.text || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/i);
  if (!m || !d.words?.length) return null;
  const mon = m[1].slice(0, 3);
  const isNum = (w) => /^\d{1,2}$/.test(w.text) && +w.text >= 1 && +w.text <= 31;
  const nums = d.words.filter(isNum);
  if (!nums.length) return null;
  const skip = /^(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday|20\d\d)$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
  const out = [];
  for (const line of d.lines || []) {
    const ws = (line.words || []).filter((w) => !isNum(w) && !skip.test(w.text.replace(/[^\w]/g, '')));
    if (!ws.length) continue;
    // split a line into pieces wherever there's a big gap (different boxes)
    const h = Math.max(10, ...ws.map((w) => w.bbox.y1 - w.bbox.y0));
    const segs = [];
    for (const w of ws) {
      const last = segs[segs.length - 1];
      if (last && w.bbox.x0 - last.x1 < h * 2) { last.text += ' ' + w.text; last.x1 = w.bbox.x1; }
      else segs.push({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0 });
    }
    for (const sg of segs) {
      if (sg.text.replace(/[^a-z]/gi, '').length < 3) continue;
      let best = null, score = Infinity;
      for (const n of nums) {
        const dy = sg.y0 - n.bbox.y1, dx = Math.abs(sg.x0 - n.bbox.x0);
        if (dy < -4 || dy > h * 12 || dx > h * 6) continue;
        const sc = dy + dx * 2;
        if (sc < score) { score = sc; best = n; }
      }
      if (best) out.push(`${mon} ${best.text} ${sg.text}`);
    }
  }
  return out.length ? out.join('\n') : null;
}

/* A wall/month calendar reads as "NOVEMBER 2026" then rows like "12 Piano 4pm  13 Dentist 9am".
   Turn each "day-number + words" piece into "Nov 12 Piano 4pm" so the normal parser can read it. */
function gridToLines(text) {
  const m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/i);
  if (!m) return text;
  const mon = m[1].slice(0, 3);
  const out = [];
  for (const line of text.split('\n')) {
    if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\d{1,2}\/\d{1,2}/i.test(line)) { out.push(line); continue; }
    // split a grid row into cells that start with a day number
    const cells = line.split(/\s{2,}|\t|\|/).map((c) => c.trim()).filter(Boolean);
    for (const c of cells) {
      const d = c.match(/^(\d{1,2})\b\s*(.*)$/);
      if (d && +d[1] >= 1 && +d[1] <= 31 && d[2].length >= 3 && !/^\s*(am|pm|:)/i.test(d[2])) out.push(`${mon} ${d[1]} ${d[2]}`);
    }
  }
  return out.join('\n');
}

/* ---------- read a dropped file into the Add form ---------- */
let ocrReady;
const loadOCR = () => (ocrReady ||= new Promise((res, rej) => {
  const sc = document.createElement('script');
  sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  sc.onload = () => res(window.Tesseract); sc.onerror = () => { ocrReady = null; rej(new Error('Couldn’t load the text reader')); };
  document.head.appendChild(sc);
}));
/* Tesseract reads dark-mode screenshots and small or dim photos badly. Give it a big, grey, high-contrast,
   dark-text-on-light copy: scale to ~2000px wide, flip light-on-dark, and stretch the contrast. */
async function prepForOcr(source) {
  let img = source;
  if (source instanceof Blob) img = await createImageBitmap(source).catch(() => null);
  if (!img) return source;
  const w0 = img.width, h0 = img.height;
  const k = Math.min(3, Math.max(0.5, 2000 / Math.max(w0, 1)), 8000 / Math.max(h0, 1)); // ~2000px wide, never absurdly tall
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) { const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; px[i] = y; hist[y]++; }
  const n = px.length / 4, pct = (p) => { let a = 0; for (let v = 0; v < 256; v++) if ((a += hist[v]) >= n * p) return v; return 255; };
  const lo = pct(0.02), hi = pct(0.98), mid = pct(0.5);
  const dark = mid < 110; // dark mode: light text on a dark background
  const span = Math.max(30, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    let y = Math.min(255, Math.max(0, (px[i] - lo) * 255 / span));
    if (dark) y = 255 - y;
    px[i] = px[i + 1] = px[i + 2] = y;
  }
  g.putImageData(d, 0, 0);
  return c;
}
async function ocr(source, status) {
  const T = await loadOCR();
  status?.('Reading the picture…');
  const r = await T.recognize(await prepForOcr(source), 'eng', { logger: (m) => { if (m.status === 'recognizing text') status(`Reading the picture… ${Math.round(m.progress * 100)}%`); } });
  return gridFromOcr(r.data) || r.data.text || '';
}
async function pdfPageImage(file) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c;
}
const ADDRESS = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.' ]{2,40}?\s(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Parkway|Hwy|Highway|Pl|Place|Cir|Circle|Trl|Trail)\b\.?(?:,?\s+[A-Za-z .]+)?(?:,?\s+(?:IN|Indiana))?(?:\s+\d{5})?/;

async function smartFill(file, f, pending, showNew) {
  const status = (t, bad) => { const el = $('#smartStatus'); if (el) { el.textContent = t; el.classList.toggle('bad', !!bad); } };
  const name = file.name.toLowerCase();
  try {
    // A calendar invite: exact details
    if (/\.(ics|ical)$/.test(name) || file.type === 'text/calendar') {
      const evs = parseICS(await file.text(), { calId: 'tmp', source: 'ics', pastDays: 1 });
      if (!evs.length) return status('No upcoming events in that invite.', true);
      if (evs.length > 1) return offerSchedule(f, evs.length, () => openImport([file]));
      const e = evs[0];
      setForm(f, { title: e.title, date: e.start.slice(0, 10), time: e.allDay ? '' : e.start.slice(11, 16), endTime: e.allDay ? '' : (e.end || '').slice(11, 16), location: e.location, notes: e.notes, guess: e.title + ' ' + e.notes });
      return status('✓ Filled in from the invite — check it and tap Save.');
    }
    let text = '';
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      status('Reading the PDF…');
      text = await pdfText(file);
      if (text.replace(/\s/g, '').length < 20) { status('It’s a scanned PDF — reading the picture…'); text = await ocr(await pdfPageImage(file), status); }
    } else if (/^image\//.test(file.type)) {
      status('Reading the picture…');
      text = await ocr(file, status);
    } else return status('Drop a PDF, a picture or a calendar invite (.ics).', true);
    if (fillFromText(text, f, status, file.name)) { pending.push(file); showNew(); }
  } catch (err) { status(err.message, true); }
}

/** Fill the Add form from any text: OCR output, a PDF, or something pasted from an email or text. */
function fillFromText(text, f, status, label = 'that') {
  {
    text = text.replace(/^(\s*>)+\s?/gm, '');
    const rows = mergeRows(parseScheduleText(splitSentences(gridToLines(text)), { base: todayWall() })).filter((r) => r.date >= todayWall());
    if (rows.length > 3 && new Set(rows.map((r) => r.date + r.time)).size > 3) { offerSchedule(f, rows.length, () => { openImport(); renderReview({ textRows: rows, label, cal: guessCalText(text) || 'family' }); }); return false; }
    if (!rows.length) {
      status('I couldn’t find a date in it — fill in the details and it’ll be attached.', true);
    } else {
      const best = rows.sort((a, b) => (!!b.time - !!a.time) || (!!b.location - !!a.location) || ((b.title || '').length - (a.title || '').length))[0];
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && l.length < 70 && !/^\d/.test(l) && !/\d{1,2}:\d{2}|\b\d{1,2}\s*[ap]m\b/i.test(l));
      const firstLine = lines.find((l) => EVENT.test(l)) || lines[0] || '';
      const words = (best.title || '').split(/\s+/).length;
      const title = best.title && best.title.length >= 3 && words <= 8 ? best.title : firstLine;
      setForm(f, { title, date: best.date, time: best.time || '', endTime: best.endTime || '', location: best.location || (text.match(ADDRESS) || [''])[0].trim(), notes: text.replace(/\s+/g, ' ').trim().slice(0, 500), guess: text });
      if (TICKETS.test(text) && !f.kind.value && kindOf({ title }) === 'other') f.kind.value = 'program';
      status('✓ Filled in from ' + label + ' — check it and tap Save.');
    }
    return true;
  }
}
const fmtHM = (hm) => { const [h, m] = hm.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
/** One line typed like a text message → its parts, or null if there's no day or time in it. */
const DAY_ABBR = { mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' };
function quickParse(line, fallbackDate) {
  const t = line.trim().replace(/\b(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b\.?(?=\s|$)/gi, (m, d) => DAY_ABBR[d.toLowerCase()]);
  if (t.length < 4) return null;
  let loc = '';
  const at = t.match(/\s(?:at|@)\s+(?![\d:]+\s*(?:am|pm|a|p)?\b)([A-Za-z][^,]{2,60})$/i);
  const body = at ? t.slice(0, at.index) : t;
  if (at) loc = at[1].trim();
  const r = parseScheduleText(body, { base: todayWall() })[0] || (fallbackDate && parseScheduleText(fallbackDate + ' ' + body)[0]);
  if (!r || (!r.time && !/\d|today|tonight|tomorrow|day\b/i.test(body))) return null;
  return { title: (r.title || '').replace(/\s+(on|at)$/i, ''), date: r.date, time: r.time, endTime: r.endTime, location: loc || r.location };
}
function setForm(f, v) {
  if (v.title) { f.title.value = v.title; f.title.dispatchEvent(new Event('input')); }
  if (v.date) { f.date.value = v.date; if (f.last) f.last.value = v.date; }
  const allDay = !v.time;
  f.allDay.checked = allDay; f.allDay.onchange();
  if (v.time) f.st.value = v.time;
  f.et.value = v.endTime || '';
  if (v.location) f.location.value = v.location;
  if (v.notes && !f.notes.value) f.notes.value = v.notes;
  if (v.guess) { const g = guessCalText(v.guess); if (g && [...f.cal.options].some((o) => o.value === g)) f.cal.value = g; }
}
function offerSchedule(f, n, go) {
  const el = $('#smartStatus');
  el.innerHTML = `This looks like a whole schedule (${n} events). <button type="button" class="btn primary" id="goSched">Review all ${n}</button>`;
  $('#goSched').onclick = () => { closeModal(); go(); };
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

/** What's on the clipboard: a copied screenshot/photo (as a file) or text. iPhone shows a small "Paste" bubble first. */
async function readClipboard() {
  try {
    for (const item of await navigator.clipboard.read()) {
      const img = item.types.find((t) => t.startsWith('image/'));
      if (img) { const b = await item.getType(img); return { file: new File([b], 'Screenshot.' + (img.split('/')[1] || 'png'), { type: img }) }; }
      if (item.types.includes('text/plain')) return { text: await (await item.getType('text/plain')).text() };
    }
  } catch {}
  try { return { text: await navigator.clipboard.readText() }; } catch { return {}; }
}
const pastedImage = (e) => [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));

function openImport(files, tab = 'file') {
  const sh = openModal(`
    <div class="head"><div><h2>Import events</h2><p class="help">Invites, schedule PDFs, flyers, photos and screenshots — or text copied from an email or team website.</p></div>
      <button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="seg"><button data-tab="file">File</button><button data-tab="text">Paste text</button><button data-tab="email">Email</button></div>
    <div data-pane="file"><label class="dropzone"><input type="file" id="files" accept=".ics,.ical,.ifb,.pdf,text/calendar,application/pdf,image/*" multiple hidden>
      <b>Tap to choose files or take a photo</b><br>Calendar invites, schedule PDFs, flyers, screenshots, or a photo of a printed calendar</label>
      <button type="button" class="btn" id="pasteShot" style="width:100%;margin-top:8px">📋 Paste a copied screenshot</button></div>
    <div data-pane="text" class="hidden"><textarea class="in" id="paste" placeholder="Paste a schedule or a screenshot — one game or practice per line works best"></textarea>
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
  $('#pasteShot', sh).onclick = async () => {
    const c = await readClipboard();
    if (c.file) return handleFiles([c.file]);
    if (c.text?.trim()) { showTab('text'); $('#paste').value = c.text; return $('#findText').click(); }
    toast('Nothing to paste — take a screenshot, tap it, then Copy (or “Copy and Delete”)', 5000);
  };
  $('#paste', sh).addEventListener('paste', (ev) => { const img = pastedImage(ev); if (img) { ev.preventDefault(); handleFiles([img]); } });
  $('#findText', sh).onclick = () => {
    const t = $('#paste').value.replace(/^(\s*>)+\s?/gm, '');
    const rows = mergeRows(parseScheduleText(splitSentences(t), { base: todayWall() }));
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
      } else if (name.endsWith('.pdf') || f.type === 'application/pdf' || /^image\//.test(f.type)) {
        const say = (t) => { review.innerHTML = `<p class="muted">${esc(t)}</p>`; };
        let text = /^image\//.test(f.type) ? '' : await pdfText(f);
        if (text.replace(/\s/g, '').length < 20) text = await ocr(/^image\//.test(f.type) ? f : await pdfPageImage(f), say);
        const rows = mergeRows(parseScheduleText(gridToLines(text), { base: todayWall() }));
        if (!rows.length) notes.push(`I couldn’t find dates in ${f.name}. Handwriting and busy wall calendars are hard to read automatically — send the photo to Claude in chat and it’ll add them.`);
        textRows.push(...rows);
      } else {
        notes.push(`${f.name}: drop a calendar invite (.ics), a PDF, or a photo/screenshot.`);
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
      ${icsEvents.map((e, i) => { const dup = findDuplicate(e); return `<label class="rrow ics"><input type="checkbox" data-i="${i}" data-k="ics" ${dup ? '' : 'checked'}>
        <span><b>${esc(e.title)}</b><br><span class="muted">${fmtDay(e.start.slice(0, 10))}${e.allDay ? '' : ' · ' + fmtTime(e.start)}${e.location ? ' · ' + esc(e.location) : ''}</span>${dup ? `<br><span class="dup">Already on the calendar: ${esc(dup.title)}</span>` : ''}</span></label>`; }).join('')}
      ${textRows.map((r, i) => { const dup = findDuplicate({ title: r.title, start: r.time ? `${r.date}T${r.time}` : r.date, allDay: !r.time }); return `<div class="rrow"><input type="checkbox" data-i="${i}" data-k="txt" ${r.title && !dup ? 'checked' : ''}>${dup ? `<div class="dup full">Already on the calendar: ${esc(dup.title)}</div>` : ''}
        <div class="fields">
          <input class="in full" data-f="title" value="${esc(r.title)}" placeholder="Title">
          <input class="in" type="date" data-f="date" value="${r.date}">
          <input class="in" type="time" data-f="time" value="${r.time || ''}">
          <input class="in full" data-f="location" value="${esc(r.location || '')}" placeholder="Where (optional)">
        </div><div class="src">From: “${esc(r.line.slice(0, 120))}”</div></div>`; }).join('')}
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
        out.push({ id: hashId(calId + '|' + start + '|' + title), cal: calId, title, start, end, allDay: !time, location, notes: '', source: 'import', createdAt: Date.now(), ...(MAYBE_RE.test(title) ? { maybe: true } : {}) });
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
const MAIL_QUERY = '-category:promotions -category:social -category:forums -in:spam (filename:ics OR invite OR invitation OR schedule OR practice OR game OR games OR tournament OR rehearsal OR recital OR program OR concert OR party OR appointment OR "save the date" OR reminder OR choir OR sing OR singing OR "field trip" OR conference OR meet OR tryouts OR banquet OR birthday OR camp OR clinic OR snack OR snacks OR volunteer OR chaperone OR concessions OR signupgenius OR "signed up" OR "sign up" OR "your slot" OR ticket OR tickets OR admission OR performance OR theatre OR theater)';

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
  return `<p class="help" style="margin-top:14px">Looks through <b>your</b> Gmail for invites, schedules and events. Anything already on the calendar is left out, and nothing is added until you check it.</p>
    <label class="f">Look back</label>
    <select class="in" id="days">
      ${[[1, 'Last day'], [3, 'Last 3 days'], [7, 'Last week'], [14, 'Last 2 weeks'], [30, 'Last month']].map(([d, t]) => `<option value="${d}" ${d === +(store.get('scanDays') || 7) ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <div class="actions"><button class="btn primary" id="scanBtn">Sign in with Google &amp; scan</button></div>`;
}

function startEmailScan() {
  // Must run straight from the tap so the Google sign-in window isn't blocked.
  const g = window.google?.accounts?.oauth2;
  if (!g) { loadGIS().catch((e) => toast(e.message, 5000)); return toast('Loading Google sign-in — tap again in a second'); }
  const client = g.initTokenClient({
    client_id: googleClientId(),
    hint: S.user?.email,
    scope: GMAIL_SCOPE,
    callback: (r) => (r.error ? toast(r.error_description || 'Google sign-in failed', 5000) : runEmailScan(r.access_token)),
    error_callback: (e) => toast(e.type === 'popup_closed' ? 'Sign-in was closed' : 'Google sign-in failed — check the Client ID setup', 5000),
  });
  client.requestAccessToken();
}

async function gm(path, token, tries = 2) {
  // A request that never answers used to freeze the whole scan: give each one 20 seconds, then try once more.
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try { r = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal }); }
  catch (e) {
    if (tries > 1) return gm(path, token, tries - 1);
    throw new Error(e.name === 'AbortError' ? 'Gmail took too long' : 'Couldn’t reach Gmail');
  } finally { clearTimeout(timer); }
  if ((r.status === 429 || r.status >= 500) && tries > 1) { await new Promise((ok) => setTimeout(ok, 1500)); return gm(path, token, tries - 1); }
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
  // A forward ("---- Forwarded message ----") is the whole point of the email: keep its quoted text.
  const fwd = /forwarded message|begin forwarded/i.test(t);
  for (let l of t.replace(/\r/g, '').split('\n')) {
    if (fwd) {
      l = l.replace(/^(\s*>)+\s?/, '');
      if (/^\s*(-{2,}\s*forwarded message|begin forwarded|(from|date|sent|to|cc|subject):\s)/i.test(l)) continue; // the forward's own header
    } else if (/^\s*(On .{5,160} wrote:|-{2,}\s*Original Message)/i.test(l)) break; // quoted replies
    if ((!fwd && /^\s*>/.test(l)) || /^\s*(Sent from my|Unsubscribe|To unsubscribe)/i.test(l)) continue;
    l = l.trim();
    if (!l) continue;
    out.push(...(l.length > 160 ? l.split(/(?<=[.!?])\s+/) : [l]).map((x) => x.slice(0, 400)));
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
  [/school|holy cross|field trip|\bband\b|concert|teacher|homeroom|classroom|\bgrade\b|factsmgt|renweb|picture day|conferences?|clhscadets|concordia/, 'school'],
];
// Whose team it is, from the coach or the grade: Troy Chapman coaches Theo, Scott Sector coaches Max.
const KID_HINTS = [[/troy chapman|\b(5th|fifth) grade/, 'Theo'], [/scott sector|\b(8th|eighth) grade/, 'Max']];
function guessCalText(t) {
  t = t.toLowerCase();
  const kid = (KID_HINTS.find(([re]) => re.test(t)) || [])[1];
  for (const [re, id] of CAL_HINTS) {
    if (!re.test(t) || !S.cal.calendars.some((c) => c.id === id)) continue;
    const c = calById(id);
    if (kid && calKid(c) && calKid(c) !== kid) {
      // e.g. "basketball" points at Max's team, but this is Theo's: use Theo's calendar for that sport, or any of Theo's
      const sport = (t.match(re) || [''])[0];
      const mine = S.cal.calendars.filter((x) => calKid(x) === kid);
      return (mine.find((x) => x.name.toLowerCase().includes(sport)) || mine[0] || { id: 'family' }).id;
    }
    return id;
  }
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
  // Team-app notices ("Troy Chapman posted in 5th Grade Boys Basketball", "new message in…") aren't events themselves.
  const notice = /\b(posted|commented|replied|reacted) (in|on|to)\b|\bliked your\b|\bsent (you )?a message\b|\bnew (message|post|comment)s? in\b|\bmentioned you\b/i.test(subject);
  if (!items.length && !mail.junk && !notice) {
    const today = todayWall(), keys = new Set();
    const cleanSubject = subject.replace(/^((re|fwd?|fw):\s*)+/i, '').slice(0, 70);
    const sent = h.date ? new Date(h.date) : null;
    const base = sent && !isNaN(sent) ? utcToWall(sent).slice(0, 10) : undefined;
    const seats = mail.ticket ? ticketNote(body) : '';
    for (const r of mergeRows(groupRows(parseScheduleText(splitSentences(cleanSubject + '\n\n' + body), { base }), cleanSubject))) {
      if (r.date < today || r.date > addDays(today, 400)) continue;
      const score = scoreRow(r, mail);
      if (score < KEEP_SCORE) continue;
      const k = r.date + '|' + r.time;
      if (keys.has(k)) {
        // a ticket repeats the show once per seat — the later copies often have the venue
        const it = items.find((x) => x.kind === 'txt' && x.row.date + '|' + x.row.time === k);
        if (it && !it.row.location && r.location) it.row.location = r.location;
        continue;
      }
      keys.add(k);
      const words = (r.title || '').split(/\s+/).length;
      const ownTitle = r.title && r.title.length >= 3 && words <= 12;
      // "dropping money to Ryan today" — a 'today/tomorrow' with no time, or a date with nothing to call it, isn't an event
      if (!r.time && (r.rel || !ownTitle)) continue;
      const title = ownTitle ? r.title : cleanSubject;
      items.push({ kind: 'txt', score, row: { ...r, title, ...(seats ? { notes: seats } : {}), ...(mail.ticket && !r.kind ? { kind: kindOf({ title }) === 'other' ? 'program' : undefined } : {}) } });
      if (items.length >= 8) break;
    }
  }
  return { id: m.id, subject, from, items, guess, junk: mail.junk };
}

/** "Row F Seat 114" ×4 → "4 tickets · Row F, seats 114, 115, 116, 117" */
function ticketNote(body) {
  const rows = new Map();
  for (const m of body.matchAll(/\brow\s+([a-z0-9]{1,3}),?\s+seat\s+(\d{1,4})\b/gi)) {
    const r = m[1].toUpperCase();
    if (!rows.has(r)) rows.set(r, new Set());
    rows.get(r).add(m[2]);
  }
  const n = [...rows.values()].reduce((a, s) => a + s.size, 0);
  if (!n) return '🎟 Tickets';
  return `🎟 ${n} ticket${n === 1 ? '' : 's'} · ` + [...rows].map(([r, s]) => `Row ${r}, seat${s.size === 1 ? '' : 's'} ${[...s].join(', ')}`).join(' · ');
}

async function runEmailScan(token) {
  const review = $('#review');
  if (!review) return;
  const days = +($('#days')?.value || 7);
  store.set('scanDays', String(days));
  review.innerHTML = `<p class="muted">Searching your email…</p>`;
  try {
    // Every matching email in the window is read each time (nothing is skipped because it was seen before);
    // events already on the calendar, or ones you said no to, are left out of the review.
    const ids = [];
    let pageToken = '';
    do {
      const list = await gm(`/messages?maxResults=100&q=${encodeURIComponent(`newer_than:${days}d ${MAIL_QUERY}`)}${pageToken ? '&pageToken=' + pageToken : ''}`, token);
      ids.push(...(list.messages || []).map((m) => m.id));
      pageToken = list.nextPageToken;
    } while (pageToken && ids.length < 400);
    const total = ids.length, queue = [...ids], found = [];
    let done = 0, stop = false;
    const progress = () => {
      review.innerHTML = `<p class="muted">Reading email ${done} of ${total}…${found.length ? ` ${found.length} with events so far.` : ''}</p>
        <button class="btn" id="stopScan">Stop &amp; show what’s found</button>`;
      $('#stopScan').onclick = () => { stop = true; queue.length = 0; };
    };
    progress();
    const work = async () => {
      while (queue.length && !stop) {
        const id = queue.shift();
        try {
          const mail = await extractMail(await gm(`/messages/${id}?format=full`, token), token);
          if (mail.items.length) found.push(mail);
        } catch (e) {
          if (/sign-in expired|said no/.test(e.message)) throw e; // real Gmail problems stop the scan
          console.warn('Skipped an email:', e); // one odd email shouldn't stop the rest
        }
        done++;
        if (!stop) progress();
      }
    };
    await Promise.all(Array.from({ length: 4 }, work));
    const no = new Set(JSON.parse(store.get('dismissedMail') || '[]'));
    for (const f of found) {
      f.items = f.items.filter((it) => {
        const r = it.kind === 'ics' ? { title: it.ev.title, start: it.ev.start, allDay: it.ev.allDay, location: it.ev.location } : { title: it.row.title, start: it.row.time ? `${it.row.date}T${it.row.time}` : it.row.date, allDay: !it.row.time, location: it.row.location };
        it.key = `${f.id}|${r.start}`;
        return !no.has(it.key) && !findDuplicate(r);
      });
    }
    store.set('lastScan', String(Date.now()));
    renderEmailReview(found.filter((f) => f.items.length), ids);
  } catch (e) {
    review.innerHTML = `<p class="bad help">${esc(e.message)}</p>`;
  }
}

/** Remember the suggestions you said no to, so they don't keep coming back. */
function dismissItems(keys) {
  const no = JSON.parse(store.get('dismissedMail') || '[]');
  store.set('dismissedMail', JSON.stringify([...no, ...keys].slice(-3000)));
}

function renderEmailReview(found, ids) {
  const review = $('#review');
  if (!review) return; // the window was closed while scanning
  const existing = new Set(allEvents().map((e) => e.title.toLowerCase() + '|' + e.start));
  if (!found.length) {
    review.innerHTML = `<p class="muted">${ids.length ? `Checked ${ids.length} email${ids.length === 1 ? '' : 's'} — everything is already on the calendar.` : 'No emails about events in that time.'}</p>`;
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
  $('#skipAll').onclick = () => { dismissItems(found.flatMap((f) => f.items.map((it) => it.key))); closeModal(); toast('Okay — those won’t show up again'); };
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
        notes: it.kind === 'ics' ? it.ev.notes : `${it.row.notes ? it.row.notes + '\n' : ''}From email: ${found[+row.dataset.m].subject} (${found[+row.dataset.m].from})`, source: 'email', createdAt: Date.now(),
        ...(it.kind === 'txt' && it.row.kind ? { kind: it.row.kind } : {}) });
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let added = 0;
      await saveCal((d) => {
        const have = new Set(d.events.map((e) => e.id));
        for (const e of out) if (!have.has(e.id)) { d.events.push(e); added++; }
      }, `Add ${out.length} events from email`);
      dismissItems($$('#rows .rrow').filter((row) => !$('input[type=checkbox]', row).checked).map((row) => found[+row.dataset.m].items[+row.dataset.i].key));
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
  if ($('#ef') && !$('#modal').classList.contains('hidden')) { $('#ef')._smart(files[0]); return; }
  if ($('#review') && !$('#modal').classList.contains('hidden')) handleFiles(files);
  else openImport(files);
});

addEventListener('paste', (e) => {
  if (e.defaultPrevented || !S.cal || !isEditor()) return;
  const img = pastedImage(e);
  if (!img) return;
  e.preventDefault();
  if ($('#ef') && !$('#modal').classList.contains('hidden')) return $('#ef')._smart(img);
  if ($('#review') && !$('#modal').classList.contains('hidden')) return handleFiles([img]);
  openImport([img]);
});

/* ---------- lists: groceries and chores ---------- */
const WHO = () => [...kidsList(), 'Mom', 'Dad'];
const listErr = (err) => toast(/permission/i.test(err.code || err.message) ? 'Lists aren’t switched on yet — Sam needs to update the database rules (see the README).' : err.message, 6000);

function openLists(tab = store.get('listTab') || 'shop') {
  S.listTab = tab; S.listsOpen = true; S.choreDay = dow(todayWall()); S.todayMode = autoMode(utcToWall(new Date()));
  const sh = openModal(`
    <div class="head"><div><h2>Lists</h2><p class="help">Shared with Emily and the kitchen display.</p></div><button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="seg listseg"><button data-lt="shop">🛒 Groceries</button><button data-lt="board">🗓️ Chore chart</button><button data-lt="todo">✅ Today</button></div>
    <div class="seg modeseg hidden"><button data-mode="am">☀️ Morning</button><button data-mode="todo">🧹 Chores</button></div>
    <div id="dayStrip" class="daystrip" role="tablist"></div>
    <form id="addItem" class="additem">
      <div class="addrow"><input class="in" name="text" maxlength="190" autocomplete="off" enterkeyhint="done" required><button class="btn primary addbtn" aria-label="Add">＋</button></div>
      <div class="choreopts hidden">
        <div class="whopick" role="group" aria-label="Who">${['', ...WHO()].map((w) => `<button type="button" data-who="${esc(w)}">${esc(w || 'Anyone')}</button>`).join('')}</div>
        <select class="in" name="repeat"></select>
        <div class="daypick hidden" role="group" aria-label="Which days">${DAY_SHORT.map((d, n) => `<button type="button" data-wd="${n}">${d[0]}</button>`).join('')}</div>
      </div>
    </form>
    <div id="listBody"></div>`);
  S.listsOpen = true;
  $('[data-close]', sh).onclick = closeModal;
  const f = $('#addItem'), opts = $('.choreopts', sh);
  let who = store.get('choreWho') || '';
  const paintWho = () => $$('[data-who]', sh).forEach((b) => {
    b.classList.toggle('on', b.dataset.who === who);
    if (!b.dataset.who) b.textContent = S.listTab === 'todo' && S.todayMode === 'am' ? 'Every kid' : 'Anyone';
  });
  // Repeat choices follow the day you're looking at: viewing Thursday, a new chore defaults to "Every Thursday".
  const fillRepeat = () => {
    const keep = f.repeat.value, had = f.repeat.options.length, day = DAY_LONG[S.choreDay];
    f.repeat.innerHTML = [['wd', `Every ${day}`], ['day', 'Every day'], ['weekdays', 'Weekdays (Mon–Fri)'], ['week', 'Once a week, any day'], ['', 'Just once'], ['pick', 'Pick days…']]
      .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    f.repeat.value = had ? keep : 'wd';
    $('.daypick', sh).classList.toggle('hidden', f.repeat.value !== 'pick');
  };
  const showOpts = () => opts.classList.toggle('hidden', S.listTab !== 'todo' || (!f.text.value.trim() && document.activeElement !== f.text && !opts.contains(document.activeElement)));
  const drawStrip = () => {
    const today = dow(todayWall());
    $('#dayStrip').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((n) => (today + n) % 7)
      .map((d) => `<button data-day="${d}" class="${d === S.choreDay ? 'on' : ''}">${d === today ? 'Today' : DAY_SHORT[d]}</button>`).join('');
    $$('[data-day]', sh).forEach((b) => (b.onclick = () => { S.choreDay = +b.dataset.day; drawStrip(); fillRepeat(); drawLists(); }));
  };
  const setTab = (t) => {
    S.listTab = t; store.set('listTab', t);
    $$('[data-lt]', sh).forEach((b) => b.classList.toggle('on', b.dataset.lt === t));
    $('#dayStrip').classList.toggle('hidden', t !== 'todo');
    $('.modeseg', sh).classList.toggle('hidden', t !== 'todo');
    $$('[data-mode]', sh).forEach((b) => b.classList.toggle('on', b.dataset.mode === S.todayMode));
    f.classList.toggle('hidden', t === 'board');
    f.text.placeholder = t === 'shop' ? 'Add an item (milk, eggs…)' : S.todayMode === 'am' ? 'Add a morning step (get dressed…)' : 'Add a chore…';
    // A new morning step goes to every kid on school mornings; a new chore to whoever was picked last.
    if (t === 'todo') { who = S.todayMode === 'am' ? '' : store.get('choreWho') || ''; f.repeat.value = S.todayMode === 'am' ? 'weekdays' : 'wd'; $('.daypick', sh).classList.add('hidden'); }
    paintWho(); showOpts(); drawLists();
  };
  $$('[data-mode]', sh).forEach((b) => (b.onclick = () => { S.todayMode = b.dataset.mode; setTab('todo'); }));
  $$('[data-lt]', sh).forEach((b) => (b.onclick = () => setTab(b.dataset.lt)));
  $$('[data-who]', sh).forEach((b) => (b.onclick = () => { who = b.dataset.who; if (S.todayMode !== 'am') store.set('choreWho', who); paintWho(); }));
  f.text.onfocus = f.text.oninput = showOpts;
  f.text.onblur = () => setTimeout(showOpts, 200);
  f.repeat.onchange = () => {
    const pick = f.repeat.value === 'pick';
    $('.daypick', sh).classList.toggle('hidden', !pick);
    if (pick && !$('.daypick .on', sh)) $(`.daypick [data-wd="${S.choreDay}"]`, sh).classList.add('on');
  };
  $$('.daypick button', sh).forEach((b) => (b.onclick = () => b.classList.toggle('on')));
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const r = f.repeat.value;
    const days = r === 'wd' ? [S.choreDay] : r === 'weekdays' ? [1, 2, 3, 4, 5] : $$('.daypick .on', sh).map((b) => +b.dataset.wd);
    if (S.listTab === 'todo' && r === 'pick' && !days.length) return toast('Pick at least one day.');
    const list = S.listTab === 'todo' ? S.todayMode : S.listTab;
    const texts = S.listTab === 'shop' ? f.text.value.split(/,|\n/).map((x) => x.trim()).filter(Boolean) : [f.text.value.trim()].filter(Boolean);
    if (!texts.length) return;
    f.text.value = ''; f.text.focus();
    const rep = ['wd', 'weekdays', 'pick'].includes(r) ? { repeat: 'days', days } : { repeat: r };
    try {
      // Morning steps for "Every kid" become one item per kid, so each kid checks off their own.
      const whos = list === 'am' && !who ? kidsList() : [who];
      for (const text of texts) for (const w of whos) {
        const item = { id: newId(), list, text: text.slice(0, 190), done: false, by: myName() || '', at: Date.now(),
          ...(S.listTab === 'todo' ? { who: w, ...rep } : {}) };
        S.items = [...S.items, item]; drawLists();
        await cloud.putItem(S.space, item);
      }
    } catch (err) { listErr(err); }
  };
  paintWho(); fillRepeat(); drawStrip(); setTab(tab);
}

function drawLists() {
  const box = $('#listBody');
  if (!box) return;
  if (S.itemsErr) { box.innerHTML = '<p class="help bad">Lists aren’t switched on yet — Sam needs to publish the new database rules (see the README).</p>'; return; }
  if (S.listTab === 'board') return drawBoard(box);
  const tab = S.listTab, t = tab === 'todo' ? S.todayMode || 'todo' : tab, daily = tab === 'todo', am = t === 'am';
  const today = dow(todayWall()), wd = daily ? S.choreDay ?? today : today, isToday = wd === today;
  // Chores: only the ones on for the day picked in the strip. Ticking off only counts for today.
  const items = S.items.filter((i) => i.list === t && (!daily || dueOn(i, wd))).sort((a, b) => (a.at || 0) - (b.at || 0));
  const doneNow = (i) => isToday && itemDone(i);
  const open = items.filter((i) => !doneNow(i)), done = items.filter(doneNow);
  const row = (i) => `<div class="item ${doneNow(i) ? 'done' : ''} ${isToday ? '' : 'plan'}" data-item="${esc(i.id)}">
      <button class="tick" aria-label="${doneNow(i) ? 'Not done' : 'Done'}" ${isToday ? '' : 'disabled'}>${doneNow(i) ? '✓' : ''}</button>
      <span class="txt">${daily ? `<span class="ic">${choreIcon(i.text)}</span>` : ''}${esc(i.text)}${daily && i.repeat && (i.repeat !== 'days' || (i.days || []).length > 1) ? `<small>${esc(choreRepeat(i))}</small>` : ''}</span>
      <button class="btn icon ghost rm" aria-label="Delete">✕</button></div>`;
  const strip = daily && !isToday && items.length ? `<p class="planhint">${DAY_LONG[wd]}’s ${am ? 'morning routine' : 'chores'} — check them off on the day.</p>` : '';
  const groups = daily
    ? [...new Set(open.map((i) => i.who || ''))].sort((a, b) => (a === '') - (b === '') || WHO().indexOf(a) - WHO().indexOf(b))
      .map((w) => `<h4>${esc(w || 'Anyone')}</h4>${open.filter((i) => (i.who || '') === w).map(row).join('')}`).join('')
    : open.map(row).join('');
  const clearable = done.filter((i) => !i.repeat);
  const none = am && !S.items.some((i) => i.list === 'am');
  const empty = t === 'shop' ? 'Nothing on the list.' : isToday && done.length ? (am ? 'Ready for school! 🎉' : 'All done today. 🎉') : `No ${am ? 'morning routine' : 'chores'} ${isToday ? 'today' : `on ${DAY_SHORT[wd]}`}.`;
  box.innerHTML = none
    ? `<p class="muted">No morning routine yet.</p><p class="help">Start everyone with ${MORNING_LIB.map((x) => `${choreIcon(x)} ${esc(x.toLowerCase())}`).join(', ')} on school mornings (Mon–Fri). Add or remove steps after.</p>
       <div class="actions"><button class="btn primary" id="seedAM">Set up the morning routine</button></div>`
    : strip + (open.length ? groups : `<p class="muted">${empty}</p>`)
    + (done.length ? `<details class="donebox" ${t === 'shop' ? 'open' : ''}><summary>${done.length} done</summary>${done.map(row).join('')}
      ${clearable.length ? `<div class="actions"><button class="btn" id="clearDone">Clear ${t === 'shop' ? 'checked items' : 'finished to-dos'}</button></div>` : ''}</details>` : '');
  $$('.item', box).forEach((el) => {
    const i = S.items.find((x) => x.id === el.dataset.item);
    $('.tick', el).onclick = async () => {
      if (!isToday) return;
      const nowDone = !itemDone(i);
      const up = i.repeat ? { ...i, doneOn: nowDone ? todayWall() : null, by: myName() || i.by || '' } : { ...i, done: nowDone, doneOn: nowDone ? todayWall() : null };
      S.items = S.items.map((x) => (x.id === i.id ? up : x)); drawLists();
      try { await cloud.putItem(S.space, up); } catch (err) { listErr(err); }
    };
    $('.rm', el).onclick = async () => {
      S.items = S.items.filter((x) => x.id !== i.id); drawLists();
      try { await cloud.delItem(S.space, i.id); } catch (err) { listErr(err); }
    };
  });
  if ($('#seedAM')) $('#seedAM').onclick = async () => {
    const add = kidsList().flatMap((k) => MORNING_LIB.map((text, n) => ({ id: newId(), list: 'am', text, who: k, done: false, repeat: 'days', days: MORNING_DAYS, by: myName() || '', at: Date.now() + n })));
    S.items = [...S.items, ...add]; drawLists();
    try { for (const it of add) await cloud.putItem(S.space, it); } catch (err) { listErr(err); }
  };
  if ($('#clearDone')) $('#clearDone').onclick = async () => {
    const ids = new Set(clearable.map((i) => i.id));
    S.items = S.items.filter((x) => !ids.has(x.id)); drawLists();
    try { for (const id of ids) await cloud.delItem(S.space, id); } catch (err) { listErr(err); }
  };
}

/* ---------- chore chart: kids down the side, days across, chores dropped into the boxes ---------- */
const chartKids = () => kidsList();
// Your own chores, saved on this phone as a list. (Older saves were plain text like "Clean attic,Fold towels".)
function customChores() {
  const raw = store.get('choreLib') || '';
  let list;
  try { list = JSON.parse(raw); } catch { list = raw.split(','); }
  return (Array.isArray(list) ? list : []).map((c) => String(c).trim()).filter((c) => c.length > 1);
}
// The chore list is shared with Emily: it lives with the calendar (choreLib), not on one phone.
// The first time, it starts from the built-in chores plus any chores added on this phone before.
function sharedChores() {
  if (Array.isArray(S.cal.choreLib)) return S.cal.choreLib;
  const seen = new Set();
  return [...CHORE_LIB, ...customChores()].filter((c) => { const k = c.trim().toLowerCase(); return !seen.has(k) && seen.add(k); });
}
async function saveChoreLib(list) {
  S.cal.choreLib = list; drawLists();
  try { await cloud.updateSpace(S.space, { choreLib: list }); store.set('choreLib', null); }
  catch (err) { toast('Couldn’t save the chore list: ' + (err.code || err.message), 5000); }
}
function choreLib() {
  const used = S.items.filter((i) => i.list === 'todo' && i.who && (i.repeat === 'days' || i.repeat === 'day')).map((i) => i.text);
  const seen = new Set();
  return [...sharedChores(), ...used].filter((c) => { const k = c.trim().toLowerCase(); return !seen.has(k) && seen.add(k); });
}
async function applyChore(changes) {
  for (const c of changes) {
    if (c.put) S.items = S.items.some((x) => x.id === c.put.id) ? S.items.map((x) => (x.id === c.put.id ? c.put : x)) : [...S.items, c.put];
    if (c.del) S.items = S.items.filter((x) => x.id !== c.del);
  }
  drawLists();
  try { for (const c of changes) { if (c.put) await cloud.putItem(S.space, c.put); if (c.del) await cloud.delItem(S.space, c.del); } } catch (err) { listErr(err); }
}
const makeChore = (x) => ({ id: newId(), list: 'todo', done: false, by: myName() || '', at: Date.now(), ...x });
function choreOn(kid, chore, wds, on) { return setChoreDay(S.items, kid, chore, wds, on, makeChore); }
const hasChore = (kid, chore, wd) => choresFor(S.items, kid, wd).some((i) => i.text.trim().toLowerCase() === chore.trim().toLowerCase());

function drawBoard(box) {
  // Move chores added on this phone (before the list was shared) into the shared list, once.
  if (!Array.isArray(S.cal.choreLib) && customChores().length && !S.choreMigrating) { S.choreMigrating = true; saveChoreLib(sharedChores()); return; }
  const kids = chartKids(), today = dow(todayWall()), sel = S.boardChore || '';
  const days = [0, 1, 2, 3, 4, 5, 6];
  box.innerHTML = `
    <p class="help">${sel ? `<b>${esc(choreIcon(sel))} ${esc(sel)}</b>: tap a box, or swipe across a row to fill several days. Tap or swipe again to take it off. Tap a name for every day.` : 'Tap a chore, then tap or swipe across the days. Or drag a chore into a box, and drag one in a box to move it.'}</p>
    <div class="palette ${S.choreEdit ? 'editing' : ''}">${choreLib().map((c) => `<button class="chorechip ${c === sel ? 'on' : ''}" data-chore="${esc(c)}"><span>${choreIcon(c)}</span>${esc(c)}${S.choreEdit ? '<b class="x">✕</b>' : ''}</button>`).join('')}
      ${S.choreEdit ? '' : '<button class="chorechip add" id="newChore">＋ New chore</button>'}
      <button class="chorechip add" id="editChores">${S.choreEdit ? 'Done editing' : '✎ Edit list'}</button></div>
    <div class="chart ${sel ? 'paint' : ''}">
      <div class="corner"></div>${days.map((d) => `<div class="dh ${d === today ? 'today' : ''}">${DAY_SHORT[d].slice(0, d === 4 || d === 2 ? 2 : 1)}</div>`).join('')}
      ${kids.map((k) => `<button class="kidname" data-kid="${esc(k)}">${esc(k)}</button>${days.map((d) => `<div class="ccell ${d === today ? 'today' : ''} ${sel && hasChore(k, sel, d) ? 'has' : ''}" data-kid="${esc(k)}" data-day="${d}">${choresFor(S.items, k, d).map((i) => `<span class="em" data-chore="${esc(i.text)}" title="${esc(i.text)}">${choreIcon(i.text)}</span>`).join('')}</div>`).join('')}`).join('')}
    </div>
    ${sel ? `<div class="actions"><button class="btn" id="unsel">Done</button></div>` : ''}`;

  const select = (c) => { S.boardChore = S.boardChore === c ? '' : c; drawLists(); };
  if ($('#newChore')) $('#newChore').onclick = () => {
    const name = (prompt('New chore (e.g. Fold towels)') || '').trim().slice(0, 60);
    if (!name) return;
    S.boardChore = name;
    if (!sharedChores().some((c) => c.toLowerCase() === name.toLowerCase())) saveChoreLib([...sharedChores(), name]); else drawLists();
  };
  if ($('#unsel')) $('#unsel').onclick = () => select('');
  $$('.kidname', box).forEach((b) => (b.onclick = () => {
    if (!sel) return toast('Pick a chore first.');
    const all = days.every((d) => hasChore(b.dataset.kid, sel, d));
    applyChore([choreOn(b.dataset.kid, sel, days, !all)]);
  }));

  // Drag: the floating icon sits just above your finger, and the chore lands in the box under the icon (lit up while you drag).
  const LIFT = 46;
  const cellAt = (x, y) => document.elementFromPoint(x, y)?.closest('.ccell, .kidname');
  const startDrag = (ev, chore, from) => {
    const sx = ev.clientX, sy = ev.clientY;
    let ghost = null, over = null;
    const move = (e) => {
      if (!ghost && Math.hypot(e.clientX - sx, e.clientY - sy) < 8) return;
      e.preventDefault();
      if (!ghost) { ghost = document.createElement('div'); ghost.className = 'dragghost'; ghost.textContent = choreIcon(chore); document.body.append(ghost); }
      ghost.style.transform = `translate(${e.clientX - 24}px, ${e.clientY - LIFT - 24}px)`;
      const c = cellAt(e.clientX, e.clientY - LIFT);
      if (c !== over) { over?.classList.remove('over'); over = c; over?.classList.add('over'); }
    };
    const up = (e) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      over?.classList.remove('over');
      if (!ghost) return select(chore);
      ghost.remove();
      const c = cellAt(e.clientX, e.clientY - LIFT);
      if (!c) return;
      const kid = c.dataset.kid, wds = c.classList.contains('kidname') ? days : [+c.dataset.day];
      if (from && from.kid === kid && wds.length === 1 && wds[0] === from.day) return;
      // Moving: take it off the old box first, then put it on the new one (built on the updated list).
      applyChore(from ? [choreOn(from.kid, chore, [from.day], false)] : []).then(() => applyChore([choreOn(kid, chore, wds, true)]));
      toast(`${choreIcon(chore)} ${chore} → ${kid}, ${wds.length > 1 ? 'every day' : DAY_LONG[wds[0]]}`);
    };
    addEventListener('pointermove', move, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  // With a chore picked: tap a box, or swipe across several boxes (Mon → Fri) to fill them all. Swiping from a box that has it clears instead.
  const startPaint = (ev, c0) => {
    const on = !hasChore(c0.dataset.kid, sel, +c0.dataset.day);
    const hit = new Map([[c0.dataset.kid + c0.dataset.day, c0]]);
    c0.classList.add('over');
    const move = (e) => {
      e.preventDefault();
      const c = document.elementFromPoint(e.clientX, e.clientY)?.closest('.ccell');
      if (c && !hit.has(c.dataset.kid + c.dataset.day)) { hit.set(c.dataset.kid + c.dataset.day, c); c.classList.add('over'); }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      const byKid = {};
      for (const c of hit.values()) (byKid[c.dataset.kid] ||= []).push(+c.dataset.day);
      applyChore(Object.entries(byKid).map(([kid, wds]) => choreOn(kid, sel, wds, on)));
    };
    addEventListener('pointermove', move, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  $('#editChores').onclick = () => { S.choreEdit = !S.choreEdit; S.boardChore = ''; drawLists(); };
  if (S.choreEdit) {
    $$('.chorechip[data-chore]', box).forEach((b) => (b.onclick = () => {
      const c = b.dataset.chore, k = c.toLowerCase();
      if (S.items.some((i) => i.list === 'todo' && i.who && i.text.trim().toLowerCase() === k && (i.repeat === 'days' || i.repeat === 'day')))
        return toast(`${c} is still on the chart — take it off the chart first.`, 4000);
      if (confirm(`Remove “${c}” from the chore list? (For both of you.)`)) saveChoreLib(sharedChores().filter((x) => x.toLowerCase() !== k));
    }));
  } else $$('.chorechip[data-chore]', box).forEach((b) => (b.onpointerdown = (e) => startDrag(e, b.dataset.chore, null)));
  $$('.ccell', box).forEach((c) => (c.onpointerdown = (e) => {
    if (sel) return startPaint(e, c);
    const em = e.target.closest('.em');
    if (em) return startDrag(e, em.dataset.chore, { kid: c.dataset.kid, day: +c.dataset.day });
    toast('Pick a chore first, or drag one in.');
  }));
}

/* ---------- phone notifications (sent by the GitHub Action, see scripts/notify.mjs) ---------- */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const REMIND = { 0: 'No reminders', 30: '30 minutes before', 60: '1 hour before', 120: '2 hours before', 1440: 'The day before' };
async function subHash(endpoint) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(b)].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const b64ToBytes = (b) => Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));

const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The app is still installing — close Settings and try again in a moment.')), 4000))]);
async function currentPush() {
  if (!pushSupported()) return null;
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const id = await subHash(sub.endpoint);
  const doc = await cloud.getPush(S.space, id).catch(() => null);
  return doc ? { id, sub, doc } : { id, sub, doc: null };
}

async function drawPush() {
  const box = $('#pushBox');
  if (!box) return;
  if (!pushSupported() || (isIOS && !isStandalone())) {
    box.innerHTML = `<p class="help">${isIOS ? 'On iPhone, notifications only work from the Home Screen app: in Safari tap <b>Share → Add to Home Screen</b>, open the calendar from that icon, then come back here.' : 'This browser can’t show notifications. Try Chrome, or add the calendar to your Home Screen.'}</p>`;
    return;
  }
  const cur = await currentPush().catch(() => null);
  const on = cur?.doc && Notification.permission === 'granted';
  if (!on) {
    box.innerHTML = `<p class="help">Get a heads-up before games and events, when a time or place changes, and a Sunday-night look at the week.</p>
      ${Notification.permission === 'denied' ? '<p class="help bad">Notifications are blocked for this app. Turn them on in your phone’s Settings → Notifications, then try again.</p>' : ''}
      <div class="actions stack"><button class="btn primary" id="pushOn">🔔 Turn on notifications</button></div>`;
    $('#pushOn').onclick = () => turnOnPush().catch((err) => toast(err.message, 6000));
    return;
  }
  const d = cur.doc;
  box.innerHTML = `<p class="help">✓ On for this phone.</p>
    <label class="f">Reminders</label><select class="in" id="pRemind">${Object.entries(REMIND).map(([k, v]) => `<option value="${k}" ${+k === +(d.remind ?? 60) ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label class="f">Only for</label><select class="in" id="pKid"><option value="">Everyone</option>${kidsList().map((k) => `<option ${d.kid === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" id="pChanges" ${d.changes !== false ? 'checked' : ''}> When a time or place changes, or something’s cancelled</label>
    <label class="check"><input type="checkbox" id="pWeekly" ${d.weekly !== false ? 'checked' : ''}> Sunday night: the week ahead</label>
    <label class="check"><input type="checkbox" id="pPrac" ${d.practices ? 'checked' : ''}> Include practices</label>
    <p class="help">Sent from the calendar’s server, which checks every few minutes — a reminder can land a little early or late.</p>
    <div class="actions"><button class="btn" id="pushOff">Turn off</button></div>`;
  const save = async () => {
    const up = { ...d, remind: +$('#pRemind').value, kid: $('#pKid').value, changes: $('#pChanges').checked, weekly: $('#pWeekly').checked, practices: $('#pPrac').checked, at: Date.now() };
    try { await cloud.putPush(S.space, cur.id, up); toast('Saved'); } catch (err) { toast(err.message, 5000); }
  };
  ['#pRemind', '#pKid', '#pChanges', '#pWeekly', '#pPrac'].forEach((q) => ($(q).onchange = save));
  $('#pushOff').onclick = async () => {
    try { await cloud.delPush(S.space, cur.id); await cur.sub.unsubscribe(); toast('Notifications off'); drawPush(); } catch (err) { toast(err.message, 5000); }
  };
}

async function turnOnPush() {
  const key = (await readRaw('data/vapid-public.txt') || '').trim();
  if (!key) throw new Error('Notifications are still being set up — try again in an hour.');
  if (await Notification.requestPermission() !== 'granted') { drawPush(); return; }
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const id = await subHash(sub.endpoint);
  const name = myName() || (isEditor() ? (S.user?.name || '').split(' ')[0] : '');
  try {
    await cloud.putPush(S.space, id, { sub: JSON.parse(JSON.stringify(sub)), name, editor: isEditor(), email: isEditor() ? S.user.email : '', remind: 60, changes: true, weekly: true, practices: showPractices(), kid: '', at: Date.now() });
  } catch (err) {
    throw new Error(/permission/i.test(err.code || err.message) ? 'Notifications aren’t switched on yet — Sam needs to update the database rules (see the README).' : err.message);
  }
  toast('🔔 Notifications on', 3000);
  drawPush();
}

/* ---------- weekly email to relatives (editors only) ---------- */
async function drawDigest() {
  const box = $('#digestBox');
  if (!box) return;
  let d = null;
  try { d = await cloud.getPrivate(S.space, 'digest'); } catch (err) {
    box.innerHTML = `<p class="help bad">${/permission/i.test(err.code || err.message) ? 'Not switched on yet — publish the new database rules (see the README).' : esc(err.message)}</p>`; return;
  }
  d ||= {};
  box.innerHTML = `<p class="help">Every Sunday evening, an email with the week’s games, concerts, church and school events (no practices, nothing 🔒) goes to these addresses.</p>
    <label class="f">Send to <span class="muted">(one email per line)</span></label>
    <textarea class="in" id="dgTo" style="min-height:90px" placeholder="grandma@example.com">${esc((d.emails || []).join('\n'))}</textarea>
    <label class="f">Send from Gmail</label><input class="in" id="dgFrom" type="email" value="${esc(d.from || S.user?.email || '')}">
    <label class="f">Gmail app password ${d.appPassword ? '<span class="muted">(saved — leave blank to keep it)</span>' : ''}</label>
    <input class="in" id="dgPass" type="password" autocomplete="off" placeholder="16 letters from myaccount.google.com/apppasswords">
    <details class="help"><summary>How do I get an app password?</summary><p>Go to <b>myaccount.google.com/apppasswords</b> (2-Step Verification has to be on), type a name like “Family calendar”, tap Create, and paste the 16 letters here. It’s only readable by you and Emily.</p></details>
    <label class="check"><input type="checkbox" id="dgOn" ${d.on !== false ? 'checked' : ''}> Send it every Sunday</label>
    <div class="actions"><button class="btn primary" id="dgSave">Save</button></div>`;
  $('#dgSave').onclick = async () => {
    const emails = [...new Set($('#dgTo').value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const bad = emails.filter((x) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x));
    if (bad.length) return toast(`Check this address: ${bad[0]}`, 4000);
    const pass = $('#dgPass').value.replace(/\s/g, '');
    if (emails.length && !pass && !d.appPassword) return toast('Add a Gmail app password so the email can be sent', 4000);
    try {
      await cloud.putPrivate(S.space, 'digest', { emails, from: $('#dgFrom').value.trim().toLowerCase(), on: $('#dgOn').checked, ...(pass ? { appPassword: pass } : {}) });
      toast(emails.length ? `Weekly email will go to ${emails.length} ${emails.length === 1 ? 'person' : 'people'}` : 'Saved');
      drawDigest();
    } catch (err) { toast(err.message, 5000); }
  };
}

/* ---------- settings ---------- */
function feedStatus(c) {
  if (!c.feedUrl) return '';
  const st = S.feeds.status?.[c.id];
  if (!st) return `<span class="st muted">Team link saved — first sync within 30 minutes</span>`;
  return st.ok ? `<span class="st ok">✓ ${st.count} events from the team app · synced ${new Date(st.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`
    : `<span class="st bad">⚠ ${esc(st.error)} — check the link</span>`;
}

function calRow(c) {
  const ed = isEditor();
  return `<div class="calrow" data-id="${esc(c.id)}">
    <input type="color" value="${esc(c.color)}" ${ed ? '' : 'disabled'} aria-label="Color">
    <input class="in name" value="${esc(c.name)}" placeholder="Calendar name" ${ed ? '' : 'disabled'}>
    ${ed ? `<button class="btn icon ghost del" aria-label="Remove">✕</button>` : '<span></span>'}
    ${ed ? `<input class="in feed" value="${esc(c.feedUrl || '')}" placeholder="Team calendar link (GameChanger, SportsYou…) — optional">
      <label class="check share"><input type="checkbox" class="shared" ${isShared(c) ? 'checked' : ''}> Extended family can see</label>
      <label class="kidw">Whose? <select class="in kidsel"><option value="">Everyone / several</option>${kidsList().map((k) => `<option ${calKid(c) === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>` : ''}
    ${ed ? feedStatus(c) : ''}
  </div>`;
}

const familyLink = () => `https://${CONFIG.owner}.github.io/${CONFIG.repo}/#s=${S.space}`;

async function drawDisplays() {
  const box = $('#displays');
  if (!box) return;
  let list = [];
  try { list = await cloud.listDisplays(S.space); } catch { return; }
  box.innerHTML = list.map((d) => `<div class="att"><span>Display added ${esc(new Date(d.at).toLocaleDateString())}${d.by ? ' by ' + esc(d.by.split('@')[0]) : ''}</span><button class="btn icon ghost" data-rmdisp="${esc(d.id)}" aria-label="Remove">✕</button></div>`).join('');
  box.querySelectorAll('[data-rmdisp]').forEach((b) => (b.onclick = async () => { await cloud.removeDisplay(S.space, b.dataset.rmdisp).catch(() => {}); drawDisplays(); }));
}

function openSettings() {
  const ed = isEditor();
  const sh = openModal(`
    <div class="head"><div><h2>Settings</h2>${S.user ? `<p class="help">Signed in as ${esc(S.user.email)}${ed ? ' · editor' : ''}</p>` : ''}</div><button class="btn icon ghost" data-close aria-label="Close">✕</button></div>

    ${ed ? `<h4>Invite family</h4>
    <p class="help">Copies a ready-to-send text with the link, the family code and how to add it to their Home Screen. They see games, concerts, school and church (not practices unless they switch them on, the Family calendar or anything 🔒), and can add their own events.</p>
    <div class="actions stack"><button class="btn primary big" id="copyInvite">📋 Copy invite message</button></div>
    <label class="f">Family code</label>
    <div class="two"><input class="in" id="famCode" value="${esc(S.cal.familyCode || 'Ahlersmeyer')}" autocomplete="off"><button class="btn" id="saveCode">Save code</button></div>
    <details class="help"><summary>Show QR code / link only</summary><div id="qr" class="qr"></div><div class="actions"><button class="btn" id="copyFamily">Copy link only</button></div></details>

    <h4>Kitchen display</h4>
    <p class="help">A big always-on view for the Echo Show (or any tablet). On the Echo say <b>“Alexa, open Silk Browser”</b>, go to <b>${esc(location.host + location.pathname.replace(/[^/]*$/, ''))}tv</b> and enter the family code. Tap the screen once to go full screen. Sign in there to include the Family calendar too.</p>

    <h4>Editors</h4>
    <p class="help">These Google accounts can add, change and delete anything, and scan their email.</p>
    <div id="eds">${(S.cal.editors || []).map((e) => `<div class="att"><span>${esc(e)}</span>${OWNERS.includes(e) ? '<span class="muted">owner</span>' : `<button class="btn icon ghost" data-rmed="${esc(e)}" aria-label="Remove">✕</button>`}</div>`).join('')}</div>
    <div class="two"><input class="in" id="newEd" type="email" placeholder="name@gmail.com"><button class="btn" id="addEd">Add editor</button></div>

    <h4>Calendars</h4>
    <div id="cals">${S.cal.calendars.map(calRow).join('')}</div>
    <div class="actions"><button class="btn" id="addCal">+ Add calendar</button><button class="btn primary" id="saveCals">Save calendars</button></div>
    <details class="help" style="margin-top:12px"><summary><b>Where do I find a team’s calendar link?</b></summary>
      <p><b>GameChanger app:</b> team → Schedule → Sync to calendar → copy the link.</p>
      <p><b>SportsYou:</b> Calendar → the calendar icon → Export/Subscribe → Copy URL.</p>
      <p>Paste it on the calendar it belongs to and tap Save. Games show up within 30 minutes and stay up to date.</p>
    </details>` : ''}

    <h4>Notifications</h4>
    <div id="pushBox"><p class="help">Checking this phone…</p></div>

    ${ed ? `<h4>Kitchen display</h4>
    <p class="help">To show private events on the Echo, tap the 🔒 line at the bottom of its screen, then type the code it shows.</p>
    <div class="two"><input class="in" id="pairCode" inputmode="numeric" maxlength="7" placeholder="6-digit code"><button class="btn primary" id="pairBtn">Show everything</button></div>
    <div id="displays"></div>` : ''}

    ${ed ? `<h4>Weekly email</h4>
    <div id="digestBox"><p class="help">Loading…</p></div>` : ''}

    <h4>Text size</h4>
    <div class="seg"><button data-size="" class="${!store.get('textSize') ? 'on' : ''}">Normal</button><button data-size="big" class="${store.get('textSize') === 'big' ? 'on' : ''}">Larger</button><button data-size="huge" class="${store.get('textSize') === 'huge' ? 'on' : ''}">Largest</button></div>

    <h4>${S.user ? 'Account' : 'Sam or Emily?'}</h4>
    <div class="actions">${S.user ? `<button class="btn" id="signOut">Sign out</button>` : `<button class="btn primary" id="signIn">Sign in with Google</button>`}</div>`);
  $('[data-close]', sh).onclick = closeModal;
  drawPush();
  if (ed) drawDigest();
  if (ed) drawDisplays();
  $$('[data-size]', sh).forEach((b) => (b.onclick = () => { store.set('textSize', b.dataset.size || null); applyTextSize(); closeModal(); openSettings(); }));
  if ($('#signIn')) $('#signIn').onclick = () => { closeModal(); cloud.signIn().catch((e) => toast(e.message, 6000)); };
  if ($('#signOut')) $('#signOut').onclick = async () => {
    closeModal();
    unsubs.forEach((u) => u()); unsubs = [];
    store.set('space', null); store.set('snap', null); if (S.user) store.set('editorSpace:' + S.user.email, null); S.space = null; S.cal = null;
    history.replaceState(null, '', location.pathname);
    await cloud.signOut();
    toast('Signed out — this device no longer shows the calendar');
  };
  if (!ed) return;

  $('#pairBtn').onclick = async () => {
    const code = $('#pairCode').value.replace(/\D/g, '');
    if (code.length !== 6) return toast('Type the 6 digits shown on the display');
    try {
      const ok = await cloud.approveDisplay(S.space, code, S.user?.email || '');
      if (!ok) return toast('That code didn’t match — tap the 🔒 line on the display again for a new one', 6000);
      $('#pairCode').value = ''; toast('Done — the display now shows everything'); drawDisplays();
    } catch (e) { toast('Couldn’t pair: ' + (e.code || e.message) + ' — publish the latest firestore.rules in Firebase', 8000); }
  };

  const link = familyLink();
  const inviteText = (code) => `You're invited to the ${S.cal.title || 'family calendar'}! 🗓

Tap to open: ${link}
If it ever asks for a family code, enter: ${code}

Put it on your Home Screen so it's one tap away:
• iPhone: open the link in Safari → tap the Share button (square with the arrow) → "Add to Home Screen" → Add
• Android: open the link in Chrome → tap ⋮ (top right) → "Add to Home screen" → Add

You'll see the kids' games, concerts, school and church events with times, places and directions. Have a birthday, dinner or visit coming up? Tap "+ Add" to put it on the calendar for everyone.

— Sam & Emily`;
  const ensureCode = async (code) => {
    if (S.cal.familyCode === code && S.cal.codeSet) return;
    await cloud.setCode(code, S.space);
    await cloud.updateSpace(S.space, { familyCode: code, codeSet: true });
    S.cal.familyCode = code; S.cal.codeSet = true;
  };
  $('#copyInvite').onclick = async () => {
    const code = $('#famCode').value.trim() || 'Ahlersmeyer';
    const text = inviteText(code);
    try { await navigator.clipboard.writeText(text); toast('Invite copied — paste it in a text to family', 4000); } catch { prompt('Copy this invite:', text); }
    ensureCode(code).catch((e) => toast('Couldn’t save the family code: ' + e.message, 5000));
  };
  $('#saveCode').onclick = async () => {
    const code = $('#famCode').value.trim();
    if (code.length < 4) return toast('Use at least 4 letters');
    try { await ensureCode(code); toast(`Family code is now “${code}”`); } catch (e) { toast(e.message, 5000); }
  };
  $('#copyFamily').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Family link copied — paste it in a text'); } catch { prompt('Copy this link:', link); } };
  loadQR().then(() => { const el = $('#qr'); if (el && window.QRCode) new window.QRCode(el, { text: link, width: 170, height: 170, correctLevel: window.QRCode.CorrectLevel.L }); }).catch(() => {});

  $('#addEd').onclick = async () => {
    const em = $('#newEd').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(em)) return toast('Enter their Google email address');
    try {
      await saveCal((d) => { d.editors = [...new Set([...(d.editors || []), em])]; });
      await cloud.setEditor(em, S.space);
      closeModal(); openSettings(); toast(`${em} can now sign in and edit`, 4000);
    } catch (err) { toast(err.message, 5000); }
  };
  $$('[data-rmed]', sh).forEach((b) => (b.onclick = async () => {
    const em = b.dataset.rmed;
    if (!confirm(`Remove ${em} as an editor?`)) return;
    try { await saveCal((d) => { d.editors = (d.editors || []).filter((x) => x !== em); }); await cloud.removeEditor(em); closeModal(); openSettings(); }
    catch (err) { toast(err.message, 5000); }
  }));

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
      return { id, name, color: $('input[type=color]', row).value, shared: $('.shared', row).checked, kid: $('.kidsel', row).value, ...(feedUrl ? { feedUrl } : {}) };
    }).filter(Boolean);
    const removed = S.cal.calendars.filter((c) => !cals.some((x) => x.id === c.id));
    let dropEvents = false;
    if (removed.length) {
      const n = S.cal.events.filter((e) => removed.some((c) => c.id === e.cal)).length;
      if (n) dropEvents = confirm(`Also delete the ${n} event${n === 1 ? '' : 's'} on ${removed.map((c) => c.name).join(', ')}?`);
    }
    try {
      await saveCal((d) => {
        d.calendars = cals;
        if (dropEvents) d.events = d.events.filter((e) => !removed.some((c) => c.id === e.cal));
      });
      closeModal(); toast('Saved', 2500);
    } catch (err) { toast(err.message, 5000); }
  };
}

/* ---------- refresh ---------- */
async function refresh() {
  if (!S.space || !S.cal) return;
  await loadFeeds();
  S.loadedAt = Date.now();
  if ($('#modal').classList.contains('hidden')) renderMain();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.cal && Date.now() - S.loadedAt > 5 * 60 * 1000) refresh();
});
// Changes that arrived while a sheet was open get drawn when it closes.
new MutationObserver(() => { if (S.dirty && $('#modal').classList.contains('hidden')) { S.dirty = false; renderMain(); } })
  .observe($('#modal'), { attributes: true, attributeFilter: ['class'] });

function applyTextSize() {
  document.documentElement.classList.remove('big', 'huge');
  const t = store.get('textSize');
  if (t) document.documentElement.classList.add(t);
}
applyTextSize();
boot();
