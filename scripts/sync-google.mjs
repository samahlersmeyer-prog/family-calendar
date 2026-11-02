// Copies the family calendar into a Google Calendar so Alexa (Echo Show home screen, "Alexa, what's on
// my calendar?") and anything else that reads Google Calendar can see it. Runs in the same GitHub Action
// as the team-feed sync, every 30 minutes. One-way: change events in the family calendar app, not in Google.
//
// Secrets (Settings → Secrets and variables → Actions):
//   GOOGLE_SA_KEY       the service account's JSON key (whole file contents)
//   GOOGLE_CALENDAR_ID  the Google Calendar to fill (Calendar settings → "Integrate calendar" → Calendar ID)
//   CAL_PASSCODE        already there for the team feeds
// Optional: ECHO_INCLUDE_PRIVATE=false to leave out the Family calendar and 🔒 events.
import { readFile } from 'node:fs/promises';
import { createSign, createHash } from 'node:crypto';
import { decryptJSON } from '../lib/crypto.js';
import { expandAll } from '../lib/events.js';
import { TZ, todayWall, addDays, addMinutes } from '../lib/tz.js';

const PROJECT = 'family-calendar-513401';
const API_KEY = 'AIzaSyC6at88xRtF-1iWgzgA6LSmcbVpDu5zxU0';
const PAST_DAYS = 7, FUTURE_DAYS = 180;
const APP_URL = 'https://samahlersmeyer-prog.github.io/family-calendar/';

const { GOOGLE_SA_KEY, GOOGLE_CALENDAR_ID, CAL_PASSCODE } = process.env;
if (!GOOGLE_SA_KEY || !GOOGLE_CALENDAR_ID) { console.log('Google Calendar sync not set up yet (GOOGLE_SA_KEY / GOOGLE_CALENDAR_ID). Skipping.'); process.exit(0); }
if (!CAL_PASSCODE) { console.error('Missing CAL_PASSCODE secret.'); process.exit(1); }
const includePrivate = process.env.ECHO_INCLUDE_PRIVATE !== 'false';

/* ---------- Google sign-in as the service account ---------- */
const b64url = (s) => Buffer.from(s).toString('base64url');
async function accessToken() {
  let key;
  try { key = JSON.parse(GOOGLE_SA_KEY); } catch { throw new Error('GOOGLE_SA_KEY isn’t valid JSON — paste the whole key file.'); }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/datastore',
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || r.status}`);
  return { token: j.access_token, email: key.client_email };
}

/* ---------- read the family calendar ---------- */
const val = (v) => v == null ? undefined
  : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue
  : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue
  : 'nullValue' in v ? null : 'timestampValue' in v ? v.timestampValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(val)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : undefined;
const docOf = (d) => val({ mapValue: { fields: d.fields || {} } });
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function readEvents(space, token) {
  const run = (auth, sharedOnly) => fetch(`${FS}/spaces/${space}:runQuery${auth ? '' : `?key=${API_KEY}`}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'events' }], ...(sharedOnly ? { where: { fieldFilter: { field: { fieldPath: 'shared' }, op: 'EQUAL', value: { booleanValue: true } } } } : {}) } }),
  });
  let r = await run(token, false);
  let all = true;
  if (r.status === 403 || r.status === 401) {
    console.log('⚠ The service account can’t read private events (give it the “Cloud Datastore Viewer” role). Copying shared events only.');
    r = await run(null, true); all = false;
  }
  if (!r.ok) throw new Error(`Couldn’t read the family calendar: HTTP ${r.status} ${await r.text()}`);
  const rows = (await r.json()).filter((x) => x.document).map((x) => docOf(x.document));
  return { events: rows, all };
}

/* ---------- Google Calendar ---------- */
const GC = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`;
let TOKEN;
async function gc(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if ((r.status === 403 || r.status === 429 || r.status >= 500) && attempt < 4) {
      const t = await r.text();
      if (r.status !== 403 || /rate|quota/i.test(t)) { await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt)); continue; }
      return { ok: false, status: r.status, text: t };
    }
    if (r.status === 204) return { ok: true, status: 204 };
    const text = await r.text();
    return { ok: r.ok, status: r.status, json: text ? JSON.parse(text) : null, text };
  }
}

// Google event ids: 5–1024 chars of a–v and 0–9. A hash of our id keeps them stable between runs.
const gid = (id) => 'fc' + createHash('sha1').update(String(id)).digest('hex');

function toGoogle(e, cals) {
  const c = cals.find((x) => x.id === e.cal) || (e.cal === 'friends' ? { name: 'Family & Friends' } : { name: '' });
  const allDay = !!e.allDay || !e.start.includes('T');
  const start = allDay ? { date: e.start.slice(0, 10) } : { dateTime: e.start.slice(0, 16) + ':00', timeZone: TZ };
  let end;
  if (allDay) {
    const s = e.start.slice(0, 10), en = (e.end || '').slice(0, 10);
    end = { date: en && en > s ? en : addDays(s, 1) };
  } else {
    const en = e.end && e.end.includes('T') && e.end > e.start ? e.end : addMinutes(e.start.slice(0, 16), 60);
    end = { dateTime: en.slice(0, 16) + ':00', timeZone: TZ };
  }
  const notes = String(e.notes || '').trim();
  const body = {
    summary: e.title,
    location: String(e.location || '').replace(/\s*\n\s*/g, ', '),
    description: [c.name ? `${c.name}` : '', notes.length > 1500 ? notes.slice(0, 1500) + '…' : notes, `From the family calendar: ${APP_URL}`].filter(Boolean).join('\n\n'),
    start, end,
    transparency: allDay ? 'transparent' : 'opaque',
    reminders: { useDefault: false, overrides: [] }, // no phone pings from this copy; the app is the source
    extendedProperties: { private: { fcId: String(e.id) } },
  };
  body.extendedProperties.private.fcHash = createHash('sha1').update(JSON.stringify([body.summary, body.location, body.description, start, end])).digest('hex').slice(0, 16);
  return body;
}

/* ---------- run ---------- */
const old = await decryptJSON(await readFile('data/calendar.enc', 'utf8'), CAL_PASSCODE);
const space = old.spaceId;
if (!space) { console.log('No calendar id yet.'); process.exit(0); }

const auth = await accessToken();
TOKEN = auth.token;

let cals = old.calendars || [];
try {
  const r = await fetch(`${FS}/spaces/${space}?key=${API_KEY}`);
  if (r.ok) cals = docOf(await r.json()).calendars || cals;
} catch {}

const { events: raw } = await readEvents(space, TOKEN);
let feeds = [];
try { feeds = (await decryptJSON(await readFile('data/feeds-space.enc', 'utf8'), space)).events || []; } catch { console.log('No team feeds file yet.'); }

const from = addDays(todayWall(), -PAST_DAYS), to = addDays(todayWall(), FUTURE_DAYS);
const wanted = new Map();
for (const e of expandAll(raw, feeds)) {
  if (!e.start || !e.title) continue;
  if (!includePrivate && (e.private || e.shared === false)) continue;
  const s = e.start.slice(0, 10), en = (e.end || e.start).slice(0, 10);
  if (en < from || s > to) continue;
  wanted.set(gid(e.id), toGoogle(e, cals));
}

// What's already in Google (only events this script made — they carry fcId)
const have = new Map();
let pageToken = '';
const timeMin = new Date(Date.parse(from + 'T00:00:00Z') - 2 * 86400e3).toISOString();
do {
  const r = await gc('GET', `${GC}?maxResults=2500&showDeleted=false&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
  if (!r.ok) {
    if (r.status === 404) throw new Error(`Google Calendar not found. Check GOOGLE_CALENDAR_ID and that the calendar is shared with ${auth.email} (“Make changes to events”).`);
    throw new Error(`Couldn’t read the Google Calendar: HTTP ${r.status} ${r.text}`);
  }
  for (const g of r.json.items || []) if (g.extendedProperties?.private?.fcId) have.set(g.id, g);
  pageToken = r.json.nextPageToken || '';
} while (pageToken);

let added = 0, changed = 0, removed = 0, failed = 0;
for (const [id, body] of wanted) {
  const g = have.get(id);
  if (g && g.extendedProperties?.private?.fcHash === body.extendedProperties.private.fcHash) continue;
  let r = g ? await gc('PUT', `${GC}/${id}`, body) : await gc('POST', GC, { id, ...body });
  // An id used before and deleted can't be inserted again — bring it back instead.
  if (!g && r.status === 409) r = await gc('PUT', `${GC}/${id}`, { ...body, status: 'confirmed' });
  if (r.ok) g ? changed++ : added++;
  else { failed++; console.log(`⚠ ${body.summary} (${body.start.date || body.start.dateTime}): HTTP ${r.status} ${String(r.text).slice(0, 200)}`); }
}
for (const [id, g] of have) {
  if (wanted.has(id)) continue;
  // Leave past events alone once they fall out of the window; remove anything cancelled or moved.
  const end = (g.end?.date || g.end?.dateTime || '').slice(0, 10);
  if (end && end < from) continue;
  const r = await gc('DELETE', `${GC}/${id}`);
  if (r.ok || r.status === 404 || r.status === 410) removed++;
  else { failed++; console.log(`⚠ couldn’t remove ${g.summary}: HTTP ${r.status}`); }
}
console.log(`Google Calendar: ${wanted.size} events in window · ${added} added, ${changed} updated, ${removed} removed${failed ? `, ${failed} failed` : ''}.`);
if (failed && failed === added + changed + removed + failed && wanted.size) process.exit(1);
