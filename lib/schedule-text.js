// Pulls dated lines out of plain text (PDF schedules, pasted emails).
// Results are always shown to a person for review before saving.
import { pad, validDate, todayWall } from './tz.js';

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RE_MON = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i;
const RE_NUM = /(?<![\d:/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/;
const RE_RANGE = /(?<![\d/:])(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)(?![a-z])/i;
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
  .replace(/^[\s,\-–—|:@•*]+|[\s,\-–—|:•*]+$/g, '').trim();

export function parseScheduleText(text, { today } = {}) {
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
    if (date) {
      if (!date[0]) date[0] = date[1] < tm - 2 ? ty + 1 : ty;
      const ds = `${date[0]}-${pad(date[1])}-${pad(date[2])}`;
      if (validDate(ds)) { lastDate = ds; rest = rest.replace(m[0], ' '); } else date = null;
    }
    let time = null, endTime = null;
    const r = rest.match(RE_RANGE);
    if (r) {
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
