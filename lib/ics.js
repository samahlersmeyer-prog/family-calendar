// Minimal iCalendar (.ics) reader: GameChanger, SportsYou, Google, Outlook, TeamSnap feeds.
import { utcToWall, wallToUtc, addDays, addMinutes, diffMinutes, dow, todayWall, pad } from './tz.js?v=44';

export function hashId(s) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 33) ^ c;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const WIN_TZ = {
  'eastern standard time': 'America/New_York', 'us eastern standard time': 'America/Indiana/Indianapolis',
  'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
};
const cleanTz = (tz) => WIN_TZ[tz.toLowerCase()] || tz.replace(/^\/[^/]+\/[^/]+\//, '');

const unesc = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDT(value, params = {}) {
  const m = (value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined) return { allDay: true, wall: `${y}-${mo}-${d}` };
  let date = null;
  try {
    if (z) date = new Date(Date.UTC(+y, mo - 1, +d, +h, +mi));
    else if (params.TZID) date = wallToUtc(+y, +mo, +d, +h, +mi, cleanTz(params.TZID));
  } catch { date = null; }
  return { allDay: false, wall: date ? utcToWall(date) : `${y}-${mo}-${d}T${h}:${mi}` };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function expand(start, rule, exdays, horizon) {
  const r = Object.fromEntries(rule.split(';').map((p) => p.split('=')));
  const interval = Math.max(1, +(r.INTERVAL || 1));
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? (parseDT(r.UNTIL)?.wall || '').slice(0, 10) : null;
  const limit = until && until < horizon ? until : horizon;
  const time = start.includes('T') ? start.slice(10) : '';
  const first = start.slice(0, 10);
  const out = [];
  let n = 0;
  const push = (day) => {
    if (day > limit || n >= count) return false;
    n++;
    if (!exdays.has(day)) out.push(day + time);
    return true;
  };
  if (r.FREQ === 'WEEKLY') {
    const set = (r.BYDAY ? r.BYDAY.split(',').map((x) => DAYS.indexOf(x.slice(-2))).filter((x) => x >= 0) : [dow(first)]).sort();
    let week = addDays(first, -dow(first));
    for (let g = 0; g < 1000; g++) {
      for (const d of set) {
        const day = addDays(week, d);
        if (day < first) continue;
        if (!push(day)) return out;
      }
      week = addDays(week, 7 * interval);
    }
  } else if (r.FREQ === 'DAILY') {
    for (let day = first, g = 0; g < 1000 && push(day); g++) day = addDays(day, interval);
  } else if (r.FREQ === 'MONTHLY' || r.FREQ === 'YEARLY') {
    const [y, m, d] = first.split('-').map(Number);
    for (let i = 0; i < 400; i++) {
      const months = r.FREQ === 'MONTHLY' ? i * interval : i * 12 * interval;
      const yy = y + Math.floor((m - 1 + months) / 12);
      const mm = ((m - 1 + months) % 12) + 1;
      const day = `${yy}-${pad(mm)}-${pad(d)}`;
      if (new Date(day + 'T00:00:00Z').getUTCDate() !== d) continue; // e.g. Feb 30
      if (!push(day)) break;
    }
  } else {
    return [start];
  }
  return out;
}

/**
 * Parse ICS text into calendar events.
 * Keeps events from `pastDays` ago through ~13 months ahead.
 */
export function parseICS(text, { calId = 'family', source = 'ics', pastDays = 60 } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const today = todayWall();
  const from = addDays(today, -pastDays);
  const horizon = addDays(today, 400);
  const out = [];
  let ev = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { ev = { _ex: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev) { try { out.push(...build(ev)); } catch {} } ev = null; continue; }
    if (!ev) continue;
    const m = line.match(/^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const params = {};
    for (const p of m[2].split(';').filter(Boolean)) {
      const i = p.indexOf('=');
      params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, '');
    }
    if (name === 'EXDATE') { for (const v of m[3].split(',')) ev._ex.push(parseDT(v, params)); continue; }
    if (!ev[name]) ev[name] = { value: m[3], params };
  }

  function build(ev) {
    if ((ev.STATUS?.value || '').toUpperCase() === 'CANCELLED') return [];
    const s = parseDT(ev.DTSTART?.value, ev.DTSTART?.params);
    if (!s) return [];
    const e = ev.DTEND ? parseDT(ev.DTEND.value, ev.DTEND.params) : null;
    let dur = e ? diffMinutes(s.wall, e.wall) : (s.allDay ? 1440 : 60);
    if (!(dur > 0)) dur = s.allDay ? 1440 : 60;
    const base = {
      cal: calId,
      title: unesc(ev.SUMMARY?.value || '(no title)').trim(),
      location: unesc(ev.LOCATION?.value || '').trim(),
      notes: unesc(ev.DESCRIPTION?.value || '').trim().slice(0, 1500),
      allDay: s.allDay,
      source,
    };
    const uid = ev.UID?.value || base.title;
    const exdays = new Set(ev._ex.filter(Boolean).map((x) => x.wall.slice(0, 10)));
    const starts = ev.RRULE ? expand(s.wall, ev.RRULE.value, exdays, horizon) : [s.wall];
    return starts
      .filter((st) => addMinutes(st, dur).slice(0, 10) >= from && st.slice(0, 10) <= horizon)
      .map((st) => ({ id: hashId(calId + '|' + uid + '|' + st), ...base, start: st, end: addMinutes(st, dur) }));
  }
  return out;
}
