// Used by Claude (or you) to add events found in email, screenshots, etc.
//   CAL_PASSCODE=... node scripts/add-events.mjs events.json   → merge events into data/calendar.enc
//   CAL_PASSCODE=... node scripts/add-events.mjs --list         → print upcoming events
// events.json: [{ "cal": "mad-apple" | "Mad Apple", "title": "...", "start": "2026-11-07T10:00",
//                 "end": "2026-11-07T12:00", "allDay": false, "location": "", "notes": "" }]
import { readFile, writeFile } from 'node:fs/promises';
import { decryptJSON, encryptJSON, saltOf } from '../lib/crypto.js';
import { hashId } from '../lib/ics.js';
import { addDays, addMinutes, todayWall } from '../lib/tz.js';

const pass = process.env.CAL_PASSCODE;
if (!pass) { console.error('Set CAL_PASSCODE'); process.exit(1); }
const raw = await readFile('data/calendar.enc', 'utf8');
const cal = await decryptJSON(raw, pass);

if (process.argv[2] === '--list') {
  const t = todayWall();
  const names = Object.fromEntries(cal.calendars.map((c) => [c.id, c.name]));
  console.log('Calendars:', cal.calendars.map((c) => `${c.id} (${c.name})`).join(', '));
  for (const e of cal.events.filter((e) => e.start >= t).sort((a, b) => a.start.localeCompare(b.start)))
    console.log(`${e.start}  [${names[e.cal] || e.cal}]  ${e.title}${e.location ? ' @ ' + e.location : ''}`);
  process.exit(0);
}

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const findCal = (v) => cal.calendars.find((c) => c.id === v || c.name.toLowerCase() === String(v).toLowerCase())?.id;
let added = 0, skipped = 0;
const ids = new Set(cal.events.map((e) => e.id));
for (const e of input) {
  const calId = findCal(e.cal) || 'family';
  const allDay = e.allDay ?? !e.start.includes('T');
  const start = allDay ? e.start.slice(0, 10) : e.start.slice(0, 16);
  const end = e.end ? (allDay ? e.end.slice(0, 10) : e.end.slice(0, 16)) : allDay ? addDays(start, 1) : addMinutes(start, 60);
  const id = hashId(calId + '|' + start + '|' + e.title);
  if (ids.has(id)) { skipped++; continue; }
  ids.add(id);
  cal.events.push({ id, cal: calId, title: e.title, start, end, allDay, location: e.location || '', notes: e.notes || '', source: e.source || 'email' });
  added++;
}
cal.updated = new Date().toISOString();
await writeFile('data/calendar.enc', await encryptJSON(cal, pass, saltOf(raw)));
console.log(`Added ${added}, skipped ${skipped} duplicates.`);
