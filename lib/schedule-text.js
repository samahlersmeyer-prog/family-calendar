// Pulls dated lines out of plain text (PDF schedules, pasted emails).
// Results are always shown to a person for review before saving.
import { pad, validDate, todayWall } from './tz.js?v=43';

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RE_MON = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i;
const RE_NUM = /(?<![\d:/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/;
const RE_RANGE = /(?<![\d/:])(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)(?![a-z])/i;
const RE_RANGE2 = /(?<![\d/:])(\d{1,2}):(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):(\d{2})(?!\s*[ap]\.?m?\b)/i;
const RE_T = /(?<![\d/:])(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?(?![a-z\d/])/gi;
const RE_DAYNAME = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b\.?,?/gi;

function toHM(h, mi, ap) {
  h = +h; mi = +(mi || 0);
  if (h > 23 || mi > 59) return null;
  if (ap) {
    ap = ap[0].toLowerCase();
    if (h > 12) return null;
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  } else if (h >= 1 && h <= 6) h += 12; // "6:00" on a sports schedule is almost always evening
  return `${pad(h)}:${pad(mi)}`;
}

const clean = (s) => s.replace(RE_DAYNAME, ' ').replace(/\s{2,}/g, ' ')
  .replace(/\s*([-–—])\s*[,;]\s*/g, ' $1 ').replace(/\s+([,;])/g, '$1').replace(/([-–—])\s*([-–—])/g, '$1')
  .replace(/\b(on|at|from)\s+(?=(on|at|from|in|with)\b|[.,;!?]|$)/gi, '').replace(/\s+(is|are|at|on|by)\s*([.!?]|$)/gi, '$2').replace(/\s{2,}/g, ' ')
  .replace(/^[\s,\-–—|:@•*]+|[\s,\-–—|:•*.]+$/g, '').replace(/^(is|are|was|will be)\s+/i, '').trim();

const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const RE_REL = /\b(today|tonight|tomorrow|(?:this |next |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i;
function relDate(word, base) {
  const w = word.toLowerCase();
  const d = new Date(base + 'T12:00:00Z');
  if (w === 'tomorrow') d.setUTCDate(d.getUTCDate() + 1);
  else if (w !== 'today' && w !== 'tonight') {
    const target = WD.findIndex((x) => w.endsWith(x));
    let n = (target - d.getUTCDay() + 7) % 7 || 7; // next one after the email was sent
    if (w.startsWith('next ') && n < 7 && d.getUTCDay() !== 0 && target > d.getUTCDay()) n += 7;
    d.setUTCDate(d.getUTCDate() + n);
  }
  return d.toISOString().slice(0, 10);
}

// A ticket or flyer often reads "Andrew Peterson / Blue Gate Theatre / 760 S Van Buren St / Dec 4 @ 7:30 pm":
// the name and the place sit on their own lines just above a bare date line.
const VENUE = /\b(center|centre|theat(er|re)|arena|stadium|church|chapel|hall|auditorium|amphitheat(er|re)|coliseum|pavilion|fieldhouse|field|park|gym|gymnasium|club|venue|ballroom|playhouse|opera house|school|complex|sportsplex|ymca)\b/i;
const ADDR = /^\d{1,6}\s+\S.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|pl|place|trl|trail)\b|,\s*[A-Z]{2}\s+\d{5}\b/i;
const NOISE = /^[A-Z0-9]{8,}$|^[\d,.$#\s-]+$|^(item|description|qty|quantity|price|total|subtotals?|fees|tickets?|row|number|section|seat selections?|sale|order|to|from|email|phone|amount paid|paid with|purchase receipt|having trouble)\b|@|https?:/i;
function fromAbove(ctx) {
  const ls = ctx.slice(-5).map(clean).filter((l) => l && l.length <= 80 && !NOISE.test(l));
  let i = ls.length;
  const loc = [];
  while (i > 1 && (ADDR.test(ls[i - 1]) || VENUE.test(ls[i - 1]))) loc.unshift(ls[--i]);
  return { title: (ls[i - 1] || '').replace(/^(19|20)\d\d\s+/, ''), location: loc.join(', ') };
}

/** base: the day the text was written (email sent date), for "tomorrow" / "Sunday". */
export function parseScheduleText(text, { today, base } = {}) {
  today ||= todayWall();
  const [ty, tm] = today.split('-').map(Number);
  const rows = [];
  let lastDate = null, header = '', place = '', above = [];
  for (const raw of text.split('\n')) {
    // Wide gaps / tabs are table columns (PDF schedules): keep them as " | ".
    let line = raw.replace(/\t|\s{2,}/g, ' | ').replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '').trim();
    if (!line) continue;
    line = line.replace(/\*+/g, '').replace(/\b([ap])\.\s?m\.?/gi, '$1m').replace(/\bnoon\b/gi, '12:00pm').trim();
    if (!line) continue;
    let rest = line, date = null, m, rel = false;
    if ((m = rest.match(RE_ISO))) date = [+m[1], +m[2], +m[3]];
    else if ((m = rest.match(RE_MON))) date = [m[3] ? +m[3] : null, MON[m[1].toLowerCase()], +m[2]];
    else if ((m = rest.match(RE_NUM))) {
      let y = m[3] ? +m[3] : null;
      if (y && y < 100) y += 2000;
      date = [y, +m[1], +m[2]];
    }
    if (!date && base && (m = rest.match(RE_REL))) {
      const ds = relDate(m[1], base);
      date = ds.split('-').map(Number);
      m = [m[0]];
      rel = true;
    }
    if (date) {
      if (!date[0]) date[0] = date[1] < tm - 2 ? ty + 1 : ty;
      const ds = `${date[0]}-${pad(date[1])}-${pad(date[2])}`;
      if (validDate(ds)) { lastDate = ds; rest = rest.replace(m[0], ' '); header = ''; place = ''; } else date = null;
    }
    let time = null, endTime = null;
    const r = rest.match(RE_RANGE);
    const r2 = !r && rest.match(RE_RANGE2);
    if (r2) {
      time = toHM(r2[1], r2[2]); endTime = toHM(r2[3], r2[4]);
      if (time && endTime && endTime < time && +r2[3] < 12) endTime = toHM(r2[3], r2[4], 'p');
      rest = rest.replace(r2[0], ' ');
    } else if (r) {
      endTime = toHM(r[4], r[5], r[6]);
      time = toHM(r[1], r[2], r[3] || r[6]);
      if (!r[3] && time && endTime && time > endTime) time = toHM(r[1], r[2], 'a');
      rest = rest.replace(r[0], ' ');
    } else {
      const t = [...rest.matchAll(RE_T)].find((x) => x[2] || x[3]);
      if (t) { time = toHM(t[1], t[2], t[3]); rest = rest.replace(t[0], ' '); }
    }
    // "At Concordia Lutheran School - 4245 Lake Ave." under a date heading = where it all happens
    if (!date && !time) {
      const at = lastDate && line.match(/^(?:at|location:?|where:?|place:?)\s+(.{4,120})$/i);
      if (at) place = at[1].replace(/\s+-\s+/, ', ').replace(/[.\s]+$/, '');
      else above.push(line);
      continue;
    }
    if (!lastDate) continue;
    const cols = rest.split('|').map(clean).filter((c) => c && !/^(tba|tbd|time|date|opponent|location)$/i.test(c));
    let title = cols[0] || '';
    let location = cols.slice(1).join(', ') || place;
    if (!title && time && above.length) { const a = fromAbove(above); title = a.title; location ||= a.location; }
    above = [];
    if (date && !time && !title) continue; // a date header like "Saturday, Nov 7"
    const headingLike = date && !time && title.length <= 40 && line.length <= 60 && !/[.!?]$/.test(line) && !/\b(is|are|was|were|will|be|at|on|from|has|have)\b/i.test(title);
    if (headingLike) header = title; // "Thursday, November 12 - CONCERT"

    rows.push({ date: lastDate, time, endTime, title, location, header: date ? '' : header, heading: !!headingLike, prose: !!(date && !time && !headingLike), rel, line: raw.replace(/\s+/g, ' ').trim() });
  }
  return rows;
}

/* ---------- tournament brackets ---------- */
// Brackets say "Sat. 2:40 p.m." with no date, and put the teams above and below each time.
// They need the text laid out in columns (pdf text with spaces kept in place).
const DAY_TIME = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/gi;
const DAY_TIME_ONE = new RegExp(DAY_TIME.source, 'i');
const DAY_OFFSET = { fri: -1, sat: 0, sun: 1, mon: 2, tue: 3, tues: 3, wed: 4, thu: 5, thur: 5, thurs: 5 };
/** Day + time with no date anywhere ("Sat. 8:00 a.m.") — a bracket or a weekend schedule. */
export const needsWeekend = (text) => (String(text).match(DAY_TIME) || []).length >= 2 && !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/i.test(text);

function addDaysISO(d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
/**
 * Every game time in a bracket, given the Saturday of that weekend.
 * → [{ date, time, title, location }] — title is "Team A vs Team B" when both teams are printed around the time.
 */
export function parseBracket(text, saturday) {
  const lines = String(text).split('\n');
  const chunks = (line) => { const out = []; const re = /\S+(?: \S+)*/g; let m; while ((m = re.exec(line))) out.push({ s: m[0], a: m.index, b: m.index + m[0].length }); return out; };
  const near = (i, mid) => (lines[i] === undefined ? null : chunks(lines[i]).find((c) => Math.abs((c.a + c.b) / 2 - mid) <= 12 && !DAY_TIME_ONE.test(c.s)));
  const isGym = (s) => /\b(gym|court|field|room|center)\b/i.test(s);
  const isTeam = (s) => s && !isGym(s) && !/^(game|bracket|champion|consolation|\d+(st|nd|rd|th) place)\b/i.test(s) && s.length <= 40;
  const rows = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(DAY_TIME)) {
      const mid = m.index + m[0].length / 2;
      let h = +m[2] % 12; if (m[4].toLowerCase() === 'p') h += 12;
      const time = `${String(h).padStart(2, '0')}:${m[3] || '00'}`;
      const date = addDaysISO(saturday, DAY_OFFSET[m[1].toLowerCase()] ?? 0);
      const above = near(i - 1, mid), b1 = near(i + 1, mid), b2 = near(i + 2, mid);
      const gym = b1 && isGym(b1.s) ? b1.s : '';
      const below = gym ? b2 : b1;
      const a = above && isTeam(above.s) ? above.s : '', b = below && isTeam(below.s) ? below.s : '';
      rows.push({ date, time, title: a && b ? `${a} vs ${b}` : 'Tournament game', location: gym, line: [a, m[0].trim(), gym, b].filter(Boolean).join(' · '), later: !(a && b) });
    }
  });
  return rows.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
}
