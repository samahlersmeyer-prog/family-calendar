// Wall-clock helpers. Every event is stored as local wall time in the family's
// time zone: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm" (timed).
export const TZ = 'America/Indiana/Indianapolis';

const fmtCache = {};
function parts(date, tz) {
  const f = (fmtCache[tz] ||= new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}

export function utcToWall(date, tz = TZ) {
  const o = parts(date, tz);
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
}

function offsetMs(date, tz) {
  const o = parts(date, tz);
  return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - date.getTime();
}

export function wallToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = offsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

export const pad = (n) => String(n).padStart(2, '0');
export const todayWall = (tz = TZ) => utcToWall(new Date(), tz).slice(0, 10);

const asUTC = (w) => new Date(w.includes('T') ? w + ':00Z' : w + 'T00:00:00Z');

export function addDays(wall, n) {
  const [d, t] = wall.split('T');
  const dt = asUTC(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  const nd = dt.toISOString().slice(0, 10);
  return t ? `${nd}T${t}` : nd;
}

export function addMinutes(wall, n) {
  if (!wall.includes('T')) return addDays(wall, Math.round(n / 1440));
  const d = asUTC(wall);
  d.setUTCMinutes(d.getUTCMinutes() + n);
  return d.toISOString().slice(0, 16);
}

export const diffMinutes = (a, b) => (asUTC(b) - asUTC(a)) / 60000;
export const dow = (day) => asUTC(day.slice(0, 10)).getUTCDay();
export const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && asUTC(s).toISOString().slice(0, 10) === s;
