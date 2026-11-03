// Kitchen display: a big, glanceable, always-updating view for the Echo Show (or any tablet/TV).
// Open https://samahlersmeyer-prog.github.io/family-calendar/tv/ and enter the family code once.
// Shows what relatives see; sign in as Sam or Emily to include the Family calendar and 🔒 events too.
import { initCloud } from '../lib/cloud.js?v=24';
import { decryptJSON } from '../lib/crypto.js?v=24';
import { expandAll, kindOf } from '../lib/events.js?v=24';
import { todayWall, utcToWall, addDays, addMinutes, diffMinutes, dow } from '../lib/tz.js?v=24';

const RAW = 'https://raw.githubusercontent.com/samahlersmeyer-prog/family-calendar/main/';
const FRIENDS = { id: 'friends', name: 'Family & Friends', color: '#0891b2' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UPCOMING_DAYS = 6;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem('fc:' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('fc:' + k) : localStorage.setItem('fc:' + k, v); } catch {} },
};
const app = $('#app');

const S = { space: null, user: null, editor: false, cal: null, events: [], feeds: [], rides: {}, items: [], updated: 0, online: navigator.onLine };
let cloud, unsubs = [];

/* ---------- formatting ---------- */
function fmtTime(wall) {
  if (!wall || !wall.includes('T')) return '';
  let [h, m] = wall.slice(11, 16).split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return { hm: `${h}:${String(m).padStart(2, '0')}`, ap };
}
const timeText = (wall) => { const t = fmtTime(wall); return t ? `${t.hm} ${t.ap}` : ''; };
const shortTime = (wall) => { const t = fmtTime(wall); return t ? `${t.hm.replace(':00', '')}${t.ap[0].toLowerCase()}` : ''; };
const md = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8)}`;

/** "Holy Cross Lutheran School, 3425 Crescent Ave" → "Holy Cross" */
function shortPlace(loc) {
  let seg = String(loc || '').split(/\n|,| — | – | \(/)[0].trim();
  if (!seg || /^\d/.test(seg)) return seg;
  seg = seg.replace(/^Allen County War Memorial\s+/i, '')
    .replace(/\s+(Evangelical\s+)?(Lutheran|Catholic|Christian|Community|Methodist|Baptist)?\s*(High School|Middle School|Elementary School|Elementary|Grade School|School|Church|Academy|Parish)$/i, '').trim();
  return seg || loc;
}
const calOf = (id) => (S.cal.calendars || []).find((c) => c.id === id) || (id === 'friends' ? FRIENDS : { id, name: '', color: '#94a3b8' });
const rideKey = (id) => String(id).replace(/\//g, '_');
const isMaybe = (e) => e.maybe || /^\s*(maybe\b|if\b|possible\b)|\bif (they|we|he|she) (win|lose|advance|qualify)/i.test(e.title);

/* ---------- data ---------- */
function eventsByDay(from, to) {
  const idx = {};
  // Signed in as Sam or Emily: everything. Otherwise what relatives see — no practices unless ?practices=1.
  const practices = S.editor || new URLSearchParams(location.search).get('practices') === '1';
  for (const e of expandAll(S.events, S.feeds)) {
    if (!practices && kindOf(e) === 'practice') continue;
    const sd = e.start.slice(0, 10);
    if (e.allDay) {
      const end = e.end && e.end > e.start ? e.end.slice(0, 10) : addDays(sd, 1);
      if (end <= from || sd > to) continue;
      for (let d = sd < from ? from : sd, i = 0; d < end && d <= to && i < 62; i++, d = addDays(d, 1)) (idx[d] ||= []).push(e);
    } else if (sd >= from && sd <= to) (idx[sd] ||= []).push(e);
  }
  for (const k in idx) idx[k].sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return idx;
}

async function loadFeeds() {
  try {
    const r = await fetch(RAW + 'data/feeds-space.enc?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) S.feeds = (await decryptJSON(await r.text(), S.space)).events || [];
  } catch {}
}

/* ---------- screens ---------- */
function renderCode(msg = '') {
  unsubs.forEach((f) => f()); unsubs = [];
  app.innerHTML = `
  <div class="center"><form class="card" id="f">
    <h1>Kitchen Calendar</h1>
    <p class="muted">Type the family code once. This screen remembers it.</p>
    ${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
    <input class="in" id="code" autocomplete="off" autocapitalize="words" placeholder="Family code">
    <button class="btn">Show the calendar</button>
  </form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#code').value.trim();
    if (!code) return;
    const sp = await cloud.lookupCode(code).catch(() => null);
    if (!sp) return renderCode('That code didn’t work — check the spelling.');
    S.space = sp; store.set('tvSpace', sp);
    history.replaceState(null, '', location.pathname + '#s=' + sp);
    start();
  };
}

async function start() {
  unsubs.forEach((f) => f()); unsubs = [];
  const sp = await cloud.getSpace(S.space).catch(() => null);
  if (!sp) { store.set('tvSpace', null); return renderCode('That calendar wasn’t found. Enter the family code again.'); }
  S.cal = sp;
  unsubs.push(cloud.watchSpace(S.space, (d) => { if (d) { S.cal = d; paint(); } }));
  unsubs.push(cloud.watchEvents(S.space, !S.editor, (docs) => { S.events = docs; S.updated = Date.now(); paint(); }, () => paint()));
  unsubs.push(cloud.watchRides(S.space, (r) => { S.rides = r || {}; paint(); }));
  unsubs.push(cloud.watchItems(S.space, (items) => { S.items = items || []; paint(); }));
  await loadFeeds();
  paint();
}

/* ---------- groceries & chores (tap to check off) ---------- */
const weekStart = (d) => addDays(d, -dow(d));
function itemDone(i) {
  if (!i.repeat) return !!i.done;
  const t = todayWall();
  return !!i.doneOn && (i.repeat === 'day' ? i.doneOn === t : i.doneOn >= weekStart(t));
}
function listsCol() {
  if (innerWidth < 900 || innerWidth <= innerHeight) return '';
  const open = S.items.filter((i) => !itemDone(i));
  const chores = open.filter((i) => i.list === 'todo'), shop = open.filter((i) => i.list === 'shop');
  const doneToday = S.items.filter((i) => i.list === 'todo' && itemDone(i) && i.doneOn === todayWall());
  if (!chores.length && !shop.length && !doneToday.length) return '';
  const row = (i, done) => `<div class="item ${done ? 'done' : ''}" data-item="${esc(i.id)}"><span class="box">${done ? '✓' : ''}</span><span class="txt">${i.who ? `<b>${esc(i.who)}:</b> ` : ''}${esc(i.text)}</span></div>`;
  return `<div class="col lists">
    ${chores.length || doneToday.length ? `<h2>Chores</h2><div class="list">${chores.sort((a, b) => (a.who || '~').localeCompare(b.who || '~')).map((i) => row(i)).join('')}${doneToday.map((i) => row(i, true)).join('')}</div>` : ''}
    ${shop.length ? `<h2>Groceries</h2><div class="list">${shop.map((i) => row(i)).join('')}</div>` : ''}
  </div>`;
}
async function tick(id) {
  const i = S.items.find((x) => x.id === id);
  if (!i) return;
  const done = !itemDone(i);
  const up = i.repeat ? { ...i, doneOn: done ? todayWall() : null } : { ...i, done, doneOn: done ? todayWall() : null };
  S.items = S.items.map((x) => (x.id === id ? up : x)); paint();
  try { await cloud.putItem(S.space, up); } catch {}
}

/* ---------- the display ---------- */
function evCard(e, now) {
  const c = calOf(e.cal);
  const t = fmtTime(e.start);
  const endSameDay = e.end && e.end.slice(0, 10) === e.start.slice(0, 10);
  const end = endSameDay ? e.end : addMinutes(e.start, 60);
  const state = end <= now ? 'done' : e.start <= now ? 'now' : '';
  const ride = S.rides[rideKey(e.id)];
  const meta = [c.name, shortPlace(e.location)].filter(Boolean).join(' · ');
  return `<div class="ev ${state}">
    <span class="bar" style="background:${esc(c.color)}"></span>
    <span class="t">${t.hm}<small>${t.ap}</small>${endSameDay ? `<small>to ${esc(shortTime(e.end))}</small>` : ''}</span>
    <span class="b">
      <div class="title">${state === 'now' ? '<span class="tag">Now</span>' : ''}${isMaybe(e) && !/^\s*maybe\b/i.test(e.title) ? '<span class="tag soft">Maybe</span>' : ''}${esc(e.title)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      ${ride ? `<div class="ride">🚗 ${esc(ride.driver)} driving</div>` : ''}
    </span></div>`;
}

function nextUp(idx, now) {
  const today = now.slice(0, 10);
  for (let i = 0; i <= UPCOMING_DAYS; i++) {
    const d = addDays(today, i);
    const e = (idx[d] || []).find((x) => !x.allDay && x.start > now && !isMaybe(x));
    if (!e) continue;
    let when;
    if (i === 0) {
      const mins = Math.round(diffMinutes(now, e.start));
      when = mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} hr${mins % 60 >= 5 ? ` ${mins % 60} min` : ''}`;
      when += ` · ${timeText(e.start)}`;
    } else when = `${i === 1 ? 'Tomorrow' : WEEKDAYS[dow(d)]} · ${timeText(e.start)}`;
    return `<div class="nextup"><div class="lbl">Next up</div><div class="what">${esc(e.title)}</div><div class="when">${esc(when)}</div></div>`;
  }
  return '';
}

function paint() {
  if (!S.cal) return;
  const nowWall = utcToWall(new Date());
  const today = nowWall.slice(0, 10);
  const idx = eventsByDay(today, addDays(today, UPCOMING_DAYS));
  const todays = idx[today] || [];
  const banners = todays.filter((e) => e.allDay);
  const timed = todays.filter((e) => !e.allDay);
  const t = fmtTime(nowWall);
  const greeting = +nowWall.slice(11, 13) < 12 ? 'Good morning' : +nowWall.slice(11, 13) < 17 ? 'Good afternoon' : 'Good evening';
  document.documentElement.classList.toggle('night', isNight(nowWall));

  const upcoming = [];
  for (let i = 1; i <= UPCOMING_DAYS; i++) {
    const d = addDays(today, i);
    const evs = idx[d] || [];
    upcoming.push(`<section class="day"><h3>${i === 1 ? 'Tomorrow' : WEEKDAYS[dow(d)]} <span>${md(d)}</span></h3>
      ${evs.length ? evs.map((e) => {
        const c = calOf(e.cal);
        const place = shortPlace(e.location);
        return `<div class="row" style="--c:${esc(c.color)}"><span class="t">${e.allDay ? 'All day' : shortTime(e.start)}</span><span class="title">${isMaybe(e) && !/^\s*maybe\b/i.test(e.title) ? 'Maybe: ' : ''}${esc(e.title)}${place ? ` <small>· ${esc(place)}</small>` : ''}</span></div>`;
      }).join('') : '<div class="row" style="--c:var(--line)"><span class="title muted">Nothing planned</span></div>'}
    </section>`);
  }

  app.innerHTML = `
  <div id="screen" class="${listsCol() ? 'withlists' : ''}">
    <header>
      <div class="clock">${t.hm}<small>${t.ap}</small></div>
      <div class="date">${WEEKDAYS[dow(today)]}, ${md(today)}<span>${greeting}${S.cal.title ? ' · ' + esc(S.cal.title) : ''}</span></div>
      ${nextUp(idx, nowWall)}
    </header>
    <div class="cols">
      <div class="col">
        <h2><b>Today</b></h2>
        <div class="list" id="today">
          ${banners.map((e) => `<span class="banner">${esc(e.title)}</span>`).join('')}
          ${timed.length ? timed.map((e) => evCard(e, nowWall)).join('') : `<div class="empty">${banners.length ? 'Nothing else planned today' : 'Nothing planned today 🎉'}</div>`}
        </div>
      </div>
      <div class="col">
        <h2>Coming up</h2>
        <div class="list" id="upcoming">${upcoming.join('')}</div>
      </div>
      ${listsCol()}
    </div>
    <footer>
      <span>${S.online ? `Updated ${shortTime(utcToWall(new Date(S.updated || Date.now())))}` : '<span class="off">Offline — showing the last update</span>'}</span>
      <span class="sp"></span>
      ${S.editor ? `<span>Showing everything for ${esc((S.user?.name || '').split(' ')[0] || S.user?.email)}</span>` : `<a href="#" id="signin">Sam or Emily: sign in to show the Family calendar too</a>`}
    </footer>
  </div>`;
  document.querySelectorAll('[data-item]').forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); tick(el.dataset.item); }));
  const si = $('#signin');
  if (si) si.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); cloud.signIn().catch(() => {}); };
  fit();
}

/** Trim what doesn't fit instead of scrolling — nobody scrolls a kitchen screen. */
function fit() {
  const today = $('#today'), up = $('#upcoming');
  if (today && today.scrollHeight > today.clientHeight) {
    today.classList.add('dense'); // smaller cards first, then drop finished events, then the latest ones
    const done = [...today.querySelectorAll('.ev.done')];
    while (today.scrollHeight > today.clientHeight && done.length) done.shift().remove();
    let hidden = 0;
    const cards = () => [...today.querySelectorAll('.ev:not(.more)')];
    while (today.scrollHeight > today.clientHeight && cards().length > 1) { cards().pop().remove(); hidden++; }
    if (hidden) today.insertAdjacentHTML('beforeend', `<div class="more">+ ${hidden} more today</div>`);
  }
  if (up && up.scrollHeight > up.clientHeight) {
    let hidden = 0;
    while (up.scrollHeight > up.clientHeight) {
      const days = up.querySelectorAll('.day');
      const last = days[days.length - 1];
      if (!last) break;
      const rows = last.querySelectorAll('.row');
      if (rows.length > 1) { rows[rows.length - 1].remove(); hidden++; }
      else if (days.length > 1) { last.remove(); hidden++; }
      else break;
    }
    if (hidden) {
      up.insertAdjacentHTML('beforeend', '<div class="more">More in the calendar app</div>');
      const days = up.querySelectorAll('.day');
      if (up.scrollHeight > up.clientHeight && days.length > 1) days[days.length - 1].remove();
    }
  }
}

// Easier on the eyes at night: dark from 8 PM to 6:30 AM (or force it with ?theme=dark / ?theme=light).
function isNight(nowWall) {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'dark') return true;
  if (q === 'light') return false;
  const hm = nowWall.slice(11, 16);
  return hm >= '20:00' || hm < '06:30';
}

/* ---------- keep the screen awake and fresh ---------- */
let wake = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); paint(); } });
// Tap anywhere to go full screen (hides the browser's address bar).
document.addEventListener('click', () => {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  keepAwake();
});
addEventListener('online', () => { S.online = true; paint(); });
addEventListener('offline', () => { S.online = false; paint(); });
addEventListener('resize', () => paint());

setInterval(paint, 20 * 1000);                    // clock, "Now", next-up countdown
setInterval(() => S.space && loadFeeds().then(paint), 15 * 60 * 1000); // team feeds (GameChanger etc.)
// Reload once a night so the screen picks up app updates and never goes stale.
setInterval(() => { const hm = utcToWall(new Date()).slice(11, 16); if (hm === '03:30' && navigator.onLine) location.reload(); }, 60 * 1000);

/* ---------- boot ---------- */
(async function boot() {
  const m = location.hash.match(/[#&]s=([\w-]{16,})/);
  S.space = m ? m[1] : store.get('tvSpace') || store.get('space');
  if (S.space) store.set('tvSpace', S.space);
  try { cloud = await initCloud(); } catch { app.innerHTML = '<div class="center muted">Couldn’t load. Check the Wi-Fi — retrying…</div>'; return setTimeout(() => location.reload(), 60 * 1000); }
  keepAwake();
  let started = false;
  cloud.onUser(async (u) => {
    S.user = u;
    let mine = null;
    if (u) { try { mine = await cloud.editorSpace(u.email); } catch {} }
    S.editor = !!mine;
    if (mine) { S.space = mine; store.set('tvSpace', mine); }
    if (!S.space) return renderCode();
    if (!started || u) { started = true; start(); }
  });
})();
