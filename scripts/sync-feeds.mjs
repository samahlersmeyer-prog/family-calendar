// Runs in GitHub Actions: pulls every calendar's team feed (GameChanger,
// SportsYou, TeamSnap, Google…) and saves them encrypted to data/feeds.enc.
import { readFile, writeFile } from 'node:fs/promises';
import { decryptJSON, encryptJSON } from '../lib/crypto.js';
import { parseICS } from '../lib/ics.js';

const pass = process.env.CAL_PASSCODE;
if (!pass) {
  console.error('Missing CAL_PASSCODE secret. Add it under Settings → Secrets and variables → Actions.');
  process.exit(1);
}

const cal = await decryptJSON(await readFile('data/calendar.enc', 'utf8'), pass)
  .catch(() => { console.error('CAL_PASSCODE does not match the calendar passcode.'); process.exit(1); });

let prev = null;
try { prev = await decryptJSON(await readFile('data/feeds.enc', 'utf8'), pass); } catch {}

const events = [];
const status = {};
for (const c of cal.calendars.filter((c) => c.feedUrl)) {
  const url = c.feedUrl.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (family-calendar sync)', Accept: 'text/calendar,*/*' }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Link is not a calendar feed');
    const evs = parseICS(text, { calId: c.id, source: 'feed', pastDays: 45 });
    events.push(...evs);
    status[c.id] = { ok: true, count: evs.length };
    console.log(`✓ ${c.name}: ${evs.length} events`);
  } catch (e) {
    // Keep the last good copy of this feed if a fetch fails.
    const old = (prev?.events || []).filter((x) => x.cal === c.id);
    events.push(...old);
    status[c.id] = { ok: false, error: String(e.message || e), count: old.length };
    console.log(`⚠ ${c.name}: ${e.message}`);
  }
}

const isShared = (c) => c.shared ?? c.id !== 'family';
const sharedIds = new Set(cal.calendars.filter(isShared).map((c) => c.id));

const strip = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, at: undefined }]));
const same = prev && JSON.stringify(prev.events) === JSON.stringify(events) && JSON.stringify(strip(prev.status || {})) === JSON.stringify(strip(status));

// Refresh "last synced" times at most every 12 hours when nothing changed.
const stale = !prev?.updated || Date.now() - Date.parse(prev.updated) > 12 * 3600 * 1000;
if (same && !stale) {
  console.log('No changes.');
} else {
  const now = new Date().toISOString();
  for (const k in status) status[k].at = now;
  await writeFile('data/feeds.enc', await encryptJSON({ updated: now, status, events }, pass));
  console.log(`Saved ${events.length} feed events.`);
}

// Extended family: a separate copy with only the shared calendars, under their own passcode.
const rel = cal.relativesPass;
if (rel) {
  const sharedCal = {
    title: cal.title,
    ...(cal.inbox ? { inbox: cal.inbox } : {}),
    calendars: cal.calendars.filter(isShared).map(({ id, name, color }) => ({ id, name, color })),
    events: cal.events.filter((e) => sharedIds.has(e.cal) && !e.private),
  };
  let old = null;
  try { old = await decryptJSON(await readFile('data/shared.enc', 'utf8'), rel); } catch {}
  if (JSON.stringify(old) !== JSON.stringify(sharedCal)) {
    await writeFile('data/shared.enc', await encryptJSON(sharedCal, rel));
    console.log(`Extended family: ${sharedCal.events.length} events on ${sharedCal.calendars.length} calendars.`);
  }
  const sharedFeeds = { events: events.filter((e) => sharedIds.has(e.cal)), status: {} };
  let oldF = null;
  try { oldF = await decryptJSON(await readFile('data/feeds-shared.enc', 'utf8'), rel); } catch {}
  if (JSON.stringify(oldF) !== JSON.stringify(sharedFeeds)) {
    await writeFile('data/feeds-shared.enc', await encryptJSON(sharedFeeds, rel));
    console.log(`Extended family feeds: ${sharedFeeds.events.length} events.`);
  }
} else {
  const { rm } = await import('node:fs/promises');
  await rm('data/shared.enc', { force: true });
  await rm('data/feeds-shared.enc', { force: true });
}
