// Shared event logic: repeating events and merging team-feed games into existing events.
// Used by the app, the kitchen display (tv/) and the Google Calendar sync (scripts/sync-google.mjs).
import { addDays, addMinutes, diffMinutes, dow, todayWall, validDate, pad } from './tz.js?v=21';

export const REPEATS = { week: 'Every week', '2weeks': 'Every 2 weeks', weekdays: 'Every weekday (Mon–Fri)', day: 'Every day', month: 'Every month (same date)' };

export function nthDate(d0, every, i) {
  if (every === 'week') return addDays(d0, 7 * i);
  if (every === '2weeks') return addDays(d0, 14 * i);
  if (every === 'month') {
    const [y, m, dd] = d0.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + i, 1));
    const c = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dd)}`;
    return validDate(c) ? c : null; // no Feb 30th
  }
  return addDays(d0, i);
}

/** One event → every date it happens on (just itself if it doesn't repeat). */
export function occurrences(e) {
  const r = e.repeat;
  if (!r || !REPEATS[r.every]) return [e];
  const d0 = e.start.slice(0, 10), t = e.start.slice(10);
  const len = e.end ? diffMinutes(e.start, e.end) : null;
  const last = addDays(d0, 730);
  const until = r.until && r.until >= d0 ? (r.until < last ? r.until : last) : addDays(todayWall(), 400) < last ? addDays(todayWall(), 400) : last;
  const skip = new Set(r.skip || []);
  const out = [];
  for (let i = 0; i < 800; i++) {
    const d = nthDate(d0, r.every, i);
    if (d === null) continue;
    if (d > until) break;
    if (skip.has(d) || (r.every === 'weekdays' && (dow(d) === 0 || dow(d) === 6))) continue;
    const start = d + t;
    out.push({ ...e, id: i === 0 ? e.id : `${e.id}~${d}`, seriesId: e.id, occ: d, start, end: len === null ? e.end : addMinutes(start, len) });
  }
  return out;
}

/**
 * A team-feed game that matches a game already on the same calendar that day is merged into it:
 * the feed's time and place win (so changes flow in), the event keeps its title, notes and attachments.
 * Returns { merged: Map(eventId → merged event), feeds: feed events that matched nothing }.
 */
export function mergeFeeds(calEvents, feedEvents) {
  const manual = new Map();
  for (const e of calEvents) if (!e.allDay && !e.repeat && !/practice|indoor/i.test(e.title)) manual.set(e.cal + '|' + e.start.slice(0, 10), e);
  const merged = new Map();
  const feeds = [];
  for (const f of feedEvents || []) {
    const m = !f.allDay && manual.get(f.cal + '|' + f.start.slice(0, 10));
    if (m) {
      // Keep our full address unless the team app points somewhere else (compare street numbers + names)
      const fl = (f.location || '').replace(/\s*\n\s*/g, ', ').trim();
      const street = fl.split(',')[0].toLowerCase();
      const location = !fl || (m.location || '').toLowerCase().includes(street) ? m.location : fl;
      merged.set(m.id, { ...m, start: f.start, end: f.end, location, feedId: f.id });
    } else feeds.push(f);
  }
  return { merged, feeds };
}

/** Everything that actually happens: approved events (repeats expanded) + team feeds, merged and de-duplicated. */
export function expandAll(calEvents, feedEvents, extra = []) {
  const { merged, feeds } = mergeFeeds(calEvents, feedEvents);
  const seen = new Set();
  const out = [];
  for (const e0 of [...calEvents.filter((e) => !e.pending).flatMap(occurrences), ...extra, ...feeds]) {
    const e = merged.get(e0.id) || e0;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}
