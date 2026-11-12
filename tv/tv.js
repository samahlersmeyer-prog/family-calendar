// Kitchen display: a big, glanceable, always-updating view for the Echo Show (or any tablet/TV).
// Open https://samahlersmeyer-prog.github.io/family-calendar/tv/ and enter the family code once.
// Shows practices plus everything relatives see (add ?practices=0 for a relative's screen);
// To include the Family calendar and 🔒 events (matching Alexa), tap the 🔒 line: the screen shows a code
// that Sam or Emily type in Settings on their phone. No Google sign-in needed on the Echo.
import { initCloud } from '../lib/cloud.js?v=43';
import { itemDone, dueToday, choreIconImg, autoMode, tickItem } from '../lib/chores.js?v=43';
import { decryptJSON } from '../lib/crypto.js?v=43';
import { expandAll, kindOf, KIDS, kidColor, calKid, titleKid } from '../lib/events.js?v=43';
import { weatherFor, isOutdoor, leaveBy } from '../lib/trip.js?v=43';
import { todayWall, utcToWall, addDays, addMinutes, diffMinutes, dow } from '../lib/tz.js?v=43';

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

const S = { space: null, user: null, editor: false, display: false, pairCode: '', cal: null, events: [], feeds: [], rides: {}, items: [], updated: 0, online: navigator.onLine };
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
  // This is the family's own kitchen screen, so practices show by default (like the Alexa calendar).
  // ?practices=0 hides them for a screen at a relative's house. Signed in as Sam or Emily: everything.
  const practices = S.editor || S.display || new URLSearchParams(location.search).get('practices') !== '0';
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
  unsubs.push(cloud.watchEvents(S.space, !(S.editor || S.display), (docs) => { S.events = docs; S.updated = Date.now(); paint(); }, () => paint()));
  unsubs.push(cloud.watchRides(S.space, (r) => { S.rides = r || {}; paint(); }));
  unsubs.push(cloud.watchItems(S.space, (items) => { S.items = items || []; paint(); }));
  await loadFeeds();
  paint();
}

/* ---------- groceries & chores (tap to check off) ---------- */
// Morning routine before 11am, chores after. Tapping the toggle switches; it goes back to automatic after 2 hours.
const emo = (code) => `<img class="cem" src="../emoji/${code}.svg" alt="" width="20" height="20">`;
function listMode() {
  if (S.modePick && Date.now() < S.modePick.until) return S.modePick.mode;
  return autoMode(utcToWall(new Date()), S.items);
}
const daily = (l) => S.items.filter((i) => i.list === l && dueToday(i));
function listsCol() {
  if (innerWidth < 900 || innerWidth <= innerHeight) return '';
  const hasAM = daily('am').length > 0, hasChores = daily('todo').length > 0;
  const mode = hasAM && hasChores ? listMode() : hasAM ? 'am' : 'todo';
  const open = S.items.filter((i) => !itemDone(i) && (i.list === 'shop' || (i.list === mode && dueToday(i))));
  const chores = open.filter((i) => i.list === mode), shop = open.filter((i) => i.list === 'shop');
  const doneToday = daily(mode).filter((i) => itemDone(i) && i.doneOn === todayWall());
  if (!chores.length && !shop.length && !doneToday.length && !(hasAM && hasChores)) return '';
  const row = (i, done) => `<div class="item ${done ? 'done' : ''}" data-item="${esc(i.id)}"><span class="box">${done ? '✓' : ''}</span><span class="txt">${i.who ? `<b>${esc(i.who)}:</b> ` : ''}${i.list === 'todo' ? choreIconImg(i.text, '../') : ''}${esc(i.text)}</span></div>`;
  // Chores grouped by kid: one card each, with a tap-to-check chip per chore.
  const kidOrder = [...(S.cal.kids || KIDS), 'Mom', 'Dad'];
  const allChores = [...chores, ...doneToday];
  const whos = [...new Set(allChores.map((i) => i.who || ''))].sort((a, b) => (a === '') - (b === '') || kidOrder.indexOf(a) - kidOrder.indexOf(b));
  const chip = (i) => { const done = itemDone(i); return `<span class="chore ${done ? 'done' : ''}" data-item="${esc(i.id)}" title="${esc(i.text)}">${choreIconImg(i.text, '../')}<span class="cw">${esc(i.text)}</span>${done ? '<b class="ck">✓</b>' : ''}</span>`; };
  // One row per kid: name, then a button per chore with its emoji and name.
  const kidCard = (w) => { const mine = allChores.filter((i) => (i.who || '') === w).sort((a, b) => (a.at || 0) - (b.at || 0));
    const left = mine.filter((i) => !itemDone(i)).length;
    return `<div class="kidchores ${left ? '' : 'alldone'}"><div class="kn">${w && kidOrder.includes(w) && (S.cal.kids || KIDS).includes(w) ? `<i class="kdot" style="background:${esc(kidColor(w, S.cal.kids || KIDS))}"></i>` : ''}${esc(w || 'Anyone')}${left ? '' : `<small>${mode === 'am' ? 'ready ✓' : 'done ✓'}</small>`}</div><div class="chips">${mine.map(chip).join('')}</div></div>`; };
  return `<div class="col lists">
    ${hasAM && hasChores ? `<div class="modes"><button data-mode="am" class="${mode === 'am' ? 'on' : ''}">${emo('2600')}Morning</button><button data-mode="todo" class="${mode === 'todo' ? 'on' : ''}">${emo('1f9f9')}Chores</button></div>` : ''}
    ${allChores.length ? `<h2>${mode === 'am' ? 'Morning routine' : 'Today’s chores'}</h2><div class="list">${whos.map(kidCard).join('')}</div>` : ''}
    ${shop.length ? `<h2>Groceries</h2><div class="list">${shop.map((i) => row(i)).join('')}</div>` : ''}
  </div>`;
}
async function tick(id) {
  const i = S.items.find((x) => x.id === id);
  if (!i) return;
  const done = !itemDone(i);
  const up = tickItem(i, done);
  S.items = S.items.map((x) => (x.id === id ? up : x)); paint();
  try { await cloud.putItem(S.space, up); } catch {}
}

/* ---------- the display ---------- */
/* Whose event: the kid's colored initial. */
const kidsOf = () => S.cal.kids || KIDS;
const kidOf = (e) => calKid(calOf(e.cal), kidsOf()) || titleKid(e.title, kidsOf());
const kb = (e) => { const k = kidOf(e); return k ? `<span class="kb" style="background:${esc(kidColor(k, kidsOf()))}">${esc(k[0])}</span>` : ''; };

/* Weather on outdoor games and "Leave by" on Next up. Looked up in the background, then the screen repaints. */
const extra = {};
function lookup(key, fn) {
  const x = extra[key];
  if (x && (x.busy || Date.now() - x.at < 30 * 60e3)) return x.val;
  extra[key] = { busy: true, at: Date.now(), val: x?.val };
  fn().then((val) => { extra[key] = { at: Date.now(), val }; paint(); }).catch(() => { extra[key] = { at: Date.now(), val: x?.val }; });
  return x?.val;
}
function wxFor(e, short = false) {
  if (!isOutdoor(e, calOf(e.cal))) return '';
  const w = lookup('wx:' + e.id + e.start, () => weatherFor(e));
  return w ? `${w.icon} ${w.temp}°${w.rain >= (short ? 40 : 20) ? ` · ${w.rain}%${short ? '' : ' rain'}` : ''}` : '';
}
function leaveFor(e) {
  if (!S.cal.home || !e.location || e.allDay) return '';
  const r = lookup('leave:' + e.id + e.start + S.cal.home, () => leaveBy(e, false, S.cal.home));
  if (!r) return '';
  return r.late ? `Leave now · ${r.drive} min drive` : `Leave by ${shortTime(r.leave)} · ${r.drive} min drive`;
}

function evCard(e, now) {
  const c = calOf(e.cal);
  const t = fmtTime(e.start);
  const endSameDay = e.end && e.end.slice(0, 10) === e.start.slice(0, 10);
  const end = endSameDay ? e.end : addMinutes(e.start, 60);
  const state = end <= now ? 'done' : e.start <= now ? 'now' : '';
  const ride = S.rides[rideKey(e.id)];
  const meta = [c.name, shortPlace(e.location), state === 'done' ? '' : wxFor(e)].filter(Boolean).join(' · ');
  return `<div class="ev ${state}">
    <span class="bar" style="background:${esc(c.color)}"></span>
    <span class="t">${t.hm}<small>${t.ap}</small>${endSameDay ? `<small>to ${esc(shortTime(e.end))}</small>` : ''}</span>
    <span class="b">
      <div class="title">${kb(e)}${state === 'now' ? '<span class="tag">Now</span>' : ''}${isMaybe(e) && !/^\s*maybe\b/i.test(e.title) ? '<span class="tag soft">Maybe</span>' : ''}${esc(e.title)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      ${ride ? `<div class="ride">🚗 ${esc(ride.driver)} driving</div>` : ''}
    </span></div>`;
}

/* ---------- tomorrow's weather (Open-Meteo: free, no key) ---------- */
// Fort Wayne. Change these if the display moves.
const WX_AT = { lat: 41.08, lon: -85.14 };
const WX_CODES = [[[0], '☀️', 'Sunny'], [[1], '🌤️', 'Mostly sunny'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Cloudy'], [[45, 48], '🌫️', 'Foggy'],
  [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 80, 81], '🌧️', 'Rain'], [[65, 82], '🌧️', 'Heavy rain'], [[66, 67], '🧊', 'Freezing rain'],
  [[71, 73, 77, 85], '🌨️', 'Snow'], [[75, 86], '❄️', 'Heavy snow'], [[95, 96, 99], '⛈️', 'Storms']];
async function loadWeather() {
  try {
    const q = `latitude=${WX_AT.lat}&longitude=${WX_AT.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&temperature_unit=fahrenheit&timezone=America%2FIndiana%2FIndianapolis&forecast_days=3`;
    const d = (await (await fetch('https://api.open-meteo.com/v1/forecast?' + q)).json()).daily;
    S.wx = d.time.map((day, i) => ({ day, code: d.weather_code[i], hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), rain: d.precipitation_probability_max[i], rise: (d.sunrise[i] || '').slice(11, 16), set: (d.sunset[i] || '').slice(11, 16) }));
  } catch { /* keep the last forecast; try again later */ }
}
function weatherBox(today) {
  const day = (d, label) => {
    const w = (S.wx || []).find((x) => x.day === d);
    if (!w) return '';
    const [, icon, word] = WX_CODES.find(([cs]) => cs.includes(w.code)) || [0, '🌡️', ''];
    return `<div class="wday"><div class="lbl">${label}</div>
      <div class="temps"><span class="ic">${icon}</span>${w.hi}°<small> / ${w.lo}°</small></div>
      <div class="when">${esc(word)}${w.rain >= 20 ? ` · 💧${w.rain}%` : ''}</div></div>`;
  };
  const html = day(today, 'Today') + day(addDays(today, 1), 'Tomorrow');
  return html ? `<div class="wx">${html}</div>` : '';
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
    const leave = i <= 1 ? leaveFor(e) : '';
    return `<div class="nextup"><div class="lbl">Next up</div><div class="what">${esc(e.title)}</div><div class="when">${esc(when)}</div>${leave ? `<div class="leave">🚗 ${esc(leave)}</div>` : ''}</div>`;
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
        const place = shortPlace(e.location), wx = wxFor(e, true);
        return `<div class="row" style="--c:${esc(c.color)}"><span class="t">${e.allDay ? 'All day' : shortTime(e.start)}</span><span class="title">${kb(e)}${isMaybe(e) && !/^\s*maybe\b/i.test(e.title) ? 'Maybe: ' : ''}${esc(e.title)}${place ? ` <small>· ${esc(place)}</small>` : ''}</span>${wx ? `<span class="rwx">${esc(wx)}</span>` : ''}</div>`;
      }).join('') : '<div class="row" style="--c:var(--line)"><span class="title muted">Nothing planned</span></div>'}
    </section>`);
  }

  app.innerHTML = `
  <div id="screen" class="${listsCol() ? 'withlists' : ''}">
    <header>
      <div class="clock">${t.hm}<small>${t.ap}</small></div>
      <div class="date">${WEEKDAYS[dow(today)]}, ${MONTHS[+today.slice(5, 7) - 1].slice(0, 3)} ${+today.slice(8)}<span>${greeting}</span></div>
      ${weatherBox(today)}
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
      ${S.editor ? `<span>Showing everything for ${esc((S.user?.name || '').split(' ')[0] || S.user?.email)}</span>` : S.display ? '<span>Showing everything</span>' : `<a href="#" id="signin" class="signin">🔒 Some events are hidden — tap here to show everything</a>`}
    </footer>
    ${S.pairCode ? `<div class="pair"><div class="card">
      <h1>Show private events</h1>
      <p>On Sam’s or Emily’s phone, open the calendar → ⚙︎ Settings → <b>Kitchen display</b>, and type:</p>
      <div class="code">${esc(S.pairCode.slice(0, 3))} ${esc(S.pairCode.slice(3))}</div>
      <p class="muted">This screen updates by itself once it’s approved.</p>
      <a href="#" id="pairCancel">Cancel</a>
    </div></div>` : ''}
  </div>`;
  document.querySelectorAll('[data-item]').forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); tick(el.dataset.item); }));
  document.querySelectorAll('[data-mode]').forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); S.modePick = { mode: el.dataset.mode, until: Date.now() + 2 * 3600 * 1000 }; paint(); }));
  const si = $('#signin');
  if (si) si.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); startPairing(); };
  const pc = $('#pairCancel');
  if (pc) pc.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); S.pairCode = ''; paint(); };
  fit();
}

/* ---------- pairing: show private events without Google sign-in ---------- */
let pairUnsub = null;
async function startPairing() {
  try {
    const uid = (await cloud.displayUid()) || (await cloud.displaySignIn());
    S.pairCode = String(Math.floor(100000 + Math.random() * 900000));
    await cloud.requestPairing(S.space, S.pairCode, uid);
    paint();
    if (pairUnsub) pairUnsub();
    pairUnsub = cloud.watchDisplay(S.space, uid, (ok) => {
      if (!ok) return;
      pairUnsub(); pairUnsub = null;
      S.pairCode = ''; S.display = true; start();
    });
  } catch (e) {
    S.pairCode = '';
    paint();
    alert('Couldn’t start pairing: ' + (e.code || e.message) + '\n\nSam: in Firebase → Authentication → Sign-in method, turn on “Anonymous”, and publish the latest firestore.rules.');
  }
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

// Easier on the eyes at night: dark from sunset to sunrise (8 PM–6:30 AM if the forecast hasn't loaded).
// Force it with ?theme=dark / ?theme=light.
function isNight(nowWall) {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'dark') return true;
  if (q === 'light') return false;
  const hm = nowWall.slice(11, 16);
  const w = (S.wx || []).find((x) => x.day === nowWall.slice(0, 10));
  const rise = w?.rise || '06:30', set = w?.set || '20:00';
  return hm >= set || hm < rise;
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
loadWeather().then(paint);
setInterval(() => loadWeather().then(paint), 30 * 60 * 1000); // tomorrow's forecast
// Reload once a night so the screen picks up app updates and never goes stale.
setInterval(() => { const hm = utcToWall(new Date()).slice(11, 16); if (hm === '03:30' && navigator.onLine) location.reload(); }, 60 * 1000);

/* ---------- boot ---------- */
(async function boot() {
  const m = location.hash.match(/[#&]s=([\w-]{16,})/);
  S.space = m ? m[1] : store.get('tvSpace') || store.get('space');
  if (S.space) store.set('tvSpace', S.space);
  try { cloud = await initCloud(); } catch { app.innerHTML = '<div class="center muted">Couldn’t load. Check the Wi-Fi — retrying…</div>'; return setTimeout(() => location.reload(), 60 * 1000); }
  keepAwake();
  const duid = await cloud.displayUid();
  if (duid && S.space) S.display = await cloud.isPairedDisplay(S.space, duid);
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
