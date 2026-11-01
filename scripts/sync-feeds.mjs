// Runs in GitHub Actions every 30 minutes: reads each calendar's team link (GameChanger,
// SportsYou, TeamSnap…) from the family calendar's settings in Firebase, pulls the games,
// and saves them encrypted with the calendar's secret id to data/feeds-space.enc.
import { readFile, writeFile } from 'node:fs/promises';
import { decryptJSON, encryptJSON } from '../lib/crypto.js';
import { parseICS } from '../lib/ics.js';

const PROJECT = 'family-calendar-513401';
const API_KEY = 'AIzaSyC6at88xRtF-1iWgzgA6LSmcbVpDu5zxU0';
const pass = process.env.CAL_PASSCODE;
if (!pass) { console.error('Missing CAL_PASSCODE secret.'); process.exit(1); }

const old = await decryptJSON(await readFile('data/calendar.enc', 'utf8'), pass);
const space = old.spaceId;
if (!space) { console.log('No calendar id yet.'); process.exit(0); }

// Firestore REST → plain JS
const val = (v) => v == null ? undefined
  : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue
  : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(val)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : null;

let calendars = old.calendars;
try {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/spaces/${space}?key=${API_KEY}`);
  if (r.ok) calendars = val({ mapValue: { fields: (await r.json()).fields } }).calendars || [];
  else console.log(`Firebase not ready (${r.status}); using the old calendar settings.`);
} catch (e) { console.log('Couldn’t reach Firebase; using the old calendar settings.'); }

const isShared = (c) => c.shared ?? c.id !== 'family';
let prev = null;
try { prev = await decryptJSON(await readFile('data/feeds-space.enc', 'utf8'), space); } catch {}

const events = [], status = {};
for (const c of calendars.filter((c) => c.feedUrl && isShared(c))) {
  const url = c.feedUrl.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (family-calendar sync)', Accept: 'text/calendar,*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Link is not a calendar feed');
    const evs = parseICS(text, { calId: c.id, source: 'feed', pastDays: 45 });
    events.push(...evs);
    status[c.id] = { ok: true, count: evs.length };
    console.log(`✓ ${c.name}: ${evs.length} events`);
  } catch (e) {
    const kept = (prev?.events || []).filter((x) => x.cal === c.id);
    events.push(...kept);
    status[c.id] = { ok: false, error: String(e.message || e), count: kept.length };
    console.log(`⚠ ${c.name}: ${e.message}`);
  }
}

const strip = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, at: undefined }]));
const same = prev && JSON.stringify(prev.events) === JSON.stringify(events) && JSON.stringify(strip(prev.status || {})) === JSON.stringify(strip(status));
const stale = !prev?.updated || Date.now() - Date.parse(prev.updated) > 12 * 3600 * 1000;
if (same && !stale) console.log('No changes.');
else {
  const now = new Date().toISOString();
  for (const k in status) status[k].at = now;
  await writeFile('data/feeds-space.enc', await encryptJSON({ updated: now, status, events }, space));
  console.log(`Saved ${events.length} feed events.`);
}
