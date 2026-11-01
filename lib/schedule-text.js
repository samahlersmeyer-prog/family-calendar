// Pulls dated lines out of plain text (PDF schedules, pasted emails).
// Results are always shown to a person for review before saving.
import { pad, validDate, todayWall } from './tz.js?v=14';

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

/** base: the day the text was written (email sent date), for "tomorrow" / "Sunday". */
export function parseScheduleText(text, { today, base } = {}) {
  today ||= todayWall();
  const [ty, tm] = today.split('-').map(Number);
  const rows = [];
  let lastDate = null;
  for (const raw of text.split('\n')) {
    // Wide gaps / tabs are table columns (PDF schedules): keep them as " | ".
    let line = raw.replace(/\t|\s{2,}/g, ' | ').replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '').trim();
    if (!line) continue;
    line = line.replace(/\b([ap])\.\s?m\.?/gi, '$1m').replace(/\bnoon\b/gi, '12:00pm');
    let rest = line, date = null, m;
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
    }
    if (date) {
      if (!date[0]) date[0] = date[1] < tm - 2 ? ty + 1 : ty;
      const ds = `${date[0]}-${pad(date[1])}-${pad(date[2])}`;
      if (validDate(ds)) { lastDate = ds; rest = rest.replace(m[0], ' '); } else date = null;
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
    if (!lastDate || (!date && !time)) continue;
    const cols = rest.split('|').map(clean).filter((c) => c && !/^(tba|tbd|time|date|opponent|location)$/i.test(c));
    const title = cols[0] || '';
    const location = cols.slice(1).join(', ');
    if (date && !time && !title) continue; // a date header like "Saturday, Nov 7"
    rows.push({ date: lastDate, time, endTime, title, location, line: raw.replace(/\s+/g, ' ').trim() });
  }
  return rows;
}
