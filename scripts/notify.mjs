// Phone notifications and the weekly email. Runs in GitHub Actions every 10 minutes
// (.github/workflows/notify.yml). Sends:
//   • reminders before events (each phone picks 30 min / 1 hr / 2 hr / the evening before)
//   • alerts when a time or place changes, or something is cancelled (next 2 weeks)
//   • Sunday evening: the week ahead, as a notification and as an email to relatives
// Secrets: CAL_PASSCODE and GOOGLE_SA_KEY (already there for the other syncs). Nothing else:
// the push keys are made on the first run and saved encrypted in data/vapid.enc; the Gmail app
// password for the weekly email is entered in the app (Settings → Weekly email).
// State (what's been sent, what the calendar looked like last run) lives in the Actions cache.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import webpush from 'web-push';
import { decryptJSON, encryptJSON } from '../lib/crypto.js';
import { expandAll, kindOf, forKid, KIDS } from '../lib/events.js';
import { todayWall, utcToWall, addDays, addMinutes, diffMinutes, dow } from '../lib/tz.js';
import { accessToken, db as firestore } from './firestore.mjs';

const { CAL_PASSCODE, GOOGLE_SA_KEY } = process.env;
const DRY = process.env.DRY_RUN === '1';
const OWNERS = ['sam.ahlersmeyer@gmail.com', 'samahlersmeyer@gmail.com'];
const APP_URL = 'https://samahlersmeyer-prog.github.io/family-calendar/';
const STATE_FILE = 'notify-state.enc'; // kept in the Actions cache, not committed
const CHANGE_DAYS = 14;
if (!CAL_PASSCODE) { console.error('Missing CAL_PASSCODE secret.'); process.exit(1); }
if (!GOOGLE_SA_KEY) { console.log('GOOGLE_SA_KEY not set — notifications need it. Skipping.'); process.exit(0); }

/* ---------- push keys (made once, saved encrypted in the repo) ---------- */
let vapid;
if (existsSync('data/vapid.enc')) vapid = await decryptJSON(await readFile('data/vapid.enc', 'utf8'), CAL_PASSCODE);
else {
  vapid = webpush.generateVAPIDKeys();
  await writeFile('data/vapid.enc', await encryptJSON(vapid, CAL_PASSCODE));
  await writeFile('data/vapid-public.txt', vapid.publicKey + '\n');
  console.log('Made new push keys (data/vapid.enc, data/vapid-public.txt).');
}
webpush.setVapidDetails('mailto:' + OWNERS[0], vapid.publicKey, vapid.privateKey);

/* ---------- the calendar ---------- */
const old = await decryptJSON(await readFile('data/calendar.enc', 'utf8'), CAL_PASSCODE);
const spaceId = old.spaceId;
if (!spaceId) { console.log('No calendar id yet.'); process.exit(0); }
const fs = firestore(await accessToken(GOOGLE_SA_KEY));
const space = (await fs.get(`spaces/${spaceId}`)) || {};
const cals = space.calendars || old.calendars || [];
const kids = space.kids || KIDS;
const editors = new Set([...(space.editors || []), ...OWNERS].map((e) => e.toLowerCase()));
const raw = await fs.all(spaceId, 'events');
let feeds = [];
try { feeds = (await decryptJSON(await readFile('data/feeds-space.enc', 'utf8'), spaceId)).events || []; } catch {}
const events = expandAll(raw, feeds).filter((e) => e.start && e.title);
const subs = (await fs.all(spaceId, 'push').catch((e) => { console.log('⚠ ' + e.message); return []; })).filter((s) => s.sub?.endpoint);
const digest = await fs.get(`spaces/${spaceId}/private/digest`).catch(() => null);

let state = { sent: {}, snap: null, dead: [], weekly: '' };
try { state = { ...state, ...(await decryptJSON(await readFile(STATE_FILE, 'utf8'), CAL_PASSCODE)) }; } catch {}
const dead = new Set(state.dead);

/* ---------- helpers ---------- */
const nowWall = utcToWall(new Date());
const today = nowWall.slice(0, 10);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const calOf = (id) => cals.find((c) => c.id === id) || (id === 'friends' ? { id, name: 'Family & Friends' } : { id, name: '' });
function fmtTime(w) {
  if (!w || !w.includes('T')) return '';
  let [h, m] = w.slice(11, 16).split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}${m ? ':' + String(m).padStart(2, '0') : ''} ${ap}`;
}
const shortTime = (w) => fmtTime(w).replace(' AM', 'a').replace(' PM', 'p');
function dayWord(d) {
  if (d === today) return 'Today';
  if (d === addDays(today, 1)) return 'Tomorrow';
  if (d > today && d <= addDays(today, 6)) return WEEKDAYS[dow(d)];
  return `${WEEKDAYS[dow(d)].slice(0, 3)}, ${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8)}`;
}
const place = (loc) => String(loc || '').split(/\n|,/)[0].trim();
const when = (e) => `${dayWord(e.start.slice(0, 10))}${e.allDay ? '' : ' ' + fmtTime(e.start)}`;
const isEditorSub = (s) => s.editor === true && editors.has(String(s.email || '').toLowerCase());
const fromFeed = (e) => e.source === 'feed' || !!e.feedId;
const isMaybe = (e) => e.maybe || /^\s*(maybe\b|if\b|possible\b)|\bif (they|we|he|she) (win|lose|advance|qualify)/i.test(e.title);

/** What this phone (or the relatives' email) is allowed and wants to see. */
function visibleTo(e, who) {
  if (e.pending) return false;
  if (!who.editor && (e.shared === false || e.private)) return false;
  if (!who.practices && kindOf(e) === 'practice') return false;
  if (who.kid && !forKid(e, who.kid, calOf(e.cal), kids)) return false;
  return true;
}

let sentCount = 0;
async function send(sub, msg) {
  if (dead.has(sub._id)) return;
  if (DRY) { console.log(`[dry] → ${sub.name || sub._id}: ${msg.title} — ${msg.body}`); sentCount++; return; }
  try {
    await webpush.sendNotification(sub.sub, JSON.stringify({ url: APP_URL, ...msg }), { TTL: 6 * 3600, urgency: 'high' });
    sentCount++;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) { dead.add(sub._id); console.log(`Phone ${sub.name || sub._id} unsubscribed; skipping it from now on.`); }
    else console.log(`⚠ push to ${sub.name || sub._id} failed: ${err.statusCode || ''} ${err.body || err.message}`);
  }
}

/* ---------- 1. reminders ---------- */
for (const s of subs) {
  const lead = +s.remind || 0;
  if (!lead) continue;
  const who = { editor: isEditorSub(s), practices: !!s.practices, kid: s.kid || '' };
  for (const e of events) {
    if (e.allDay || isMaybe(e) || e.start <= nowWall || !visibleTo(e, who)) continue;
    const trigger = lead === 1440 ? `${addDays(e.start.slice(0, 10), -1)}T19:00` : addMinutes(e.start.slice(0, 16), -lead);
    if (nowWall < trigger) continue;
    const key = `r|${s._id}|${e.id}|${e.start}|${lead}`;
    if (state.sent[key]) continue;
    state.sent[key] = Date.now();
    const mins = Math.round(diffMinutes(nowWall, e.start.slice(0, 16)));
    const head = lead === 1440 ? `Tomorrow ${fmtTime(e.start)}` : mins < 60 ? `In ${mins} min` : `In ${Math.floor(mins / 60)} hr${mins % 60 >= 10 ? ` ${mins % 60} min` : ''}`;
    await send(s, { title: `${head}: ${e.title}`, body: [fmtTime(e.start), place(e.location), calOf(e.cal).name].filter(Boolean).join(' · '), tag: 'r-' + e.id });
  }
}

/* ---------- 2. changes and cancellations ---------- */
const horizon = addDays(today, CHANGE_DAYS);
const snap = {};
for (const e of events) {
  if (e.start.slice(0, 10) < today || e.start.slice(0, 10) > horizon) continue;
  snap[e.id] = { s: e.start, l: place(e.location), t: e.title, f: fromFeed(e), cal: e.cal, sh: e.shared !== false && !e.private, k: kindOf(e), all: !!e.allDay };
}
if (state.snap) {
  const changes = [];
  for (const [id, now] of Object.entries(snap)) {
    const was = state.snap[id];
    if (!was || (!now.all && now.s.slice(0, 16) <= nowWall)) continue;
    const timeMoved = was.s !== now.s, placeMoved = was.l.toLowerCase() !== now.l.toLowerCase() && now.l;
    if (timeMoved || placeMoved) changes.push({ id, now, was, timeMoved, placeMoved });
  }
  const gone = Object.entries(state.snap).filter(([id, was]) => !snap[id] && was.s.slice(0, 16) > nowWall && was.s.slice(0, 10) <= horizon);
  // Lots disappearing at once is a bulk edit or a feed hiccup, not cancellations.
  if (gone.length <= 3) for (const [id, was] of gone) changes.push({ id, was, cancelled: true });
  if (changes.length) console.log(`${changes.length} change(s) in the next ${CHANGE_DAYS} days.`);
  for (const s of subs) {
    if (s.changes === false) continue;
    const who = { editor: isEditorSub(s), practices: !!s.practices, kid: s.kid || '' };
    const mine = changes.filter((c) => {
      const e = c.now || c.was;
      // Sam & Emily made their own edits; they only hear about changes that came from the team apps.
      if (who.editor && !e.f) return false;
      return visibleTo({ title: e.t, cal: e.cal, shared: e.sh, kind: e.k, start: e.s }, who);
    });
    if (!mine.length) continue;
    if (mine.length > 3) { await send(s, { title: `${mine.length} calendar changes`, body: mine.slice(0, 4).map((c) => (c.now || c.was).t).join(' · '), tag: 'changes' }); continue; }
    for (const c of mine) {
      if (c.cancelled) await send(s, { title: `Cancelled: ${c.was.t}`, body: `Was ${when({ start: c.was.s, allDay: c.was.all })}`, tag: 'c-' + c.id });
      else await send(s, {
        title: `${c.timeMoved ? 'New time' : 'New place'}: ${c.now.t}`,
        body: [c.timeMoved ? `${when({ start: c.now.s, allDay: c.now.all })} (was ${c.was.s.slice(0, 10) === c.now.s.slice(0, 10) ? fmtTime(c.was.s) : when({ start: c.was.s, allDay: c.was.all })})` : when({ start: c.now.s, allDay: c.now.all }), c.placeMoved ? c.now.l : ''].filter(Boolean).join(' · '),
        tag: 'c-' + c.id,
      });
    }
  }
}
state.snap = snap;

/* ---------- 3. Sunday evening: the week ahead ---------- */
function weekAhead(who) {
  const from = addDays(today, 1), to = addDays(today, 7);
  return events.filter((e) => e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to && visibleTo(e, who))
    .sort((a, b) => a.start.localeCompare(b.start));
}
const isSundayEvening = dow(today) === 0 && nowWall.slice(11, 16) >= '18:00';
if ((isSundayEvening && state.weekly !== today) || process.env.FORCE_WEEKLY === '1') {
  state.weekly = today;
  for (const s of subs) {
    if (s.weekly === false) continue;
    const list = weekAhead({ editor: isEditorSub(s), practices: !!s.practices, kid: s.kid || '' });
    if (!list.length) continue;
    const lines = list.slice(0, 6).map((e) => `${WEEKDAYS[dow(e.start)].slice(0, 3)} ${e.allDay ? '' : shortTime(e.start) + ' '}${e.title}`);
    await send(s, { title: `The week ahead: ${list.length} event${list.length === 1 ? '' : 's'}`, body: lines.join('\n') + (list.length > 6 ? `\n+ ${list.length - 6} more` : ''), tag: 'weekly' });
  }
  if (digest?.on !== false && digest?.emails?.length && digest.appPassword && digest.from) await sendDigestEmail(digest);
}

async function sendDigestEmail(d) {
  const list = weekAhead({ editor: false, practices: false, kid: '' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = `${APP_URL}#s=${spaceId}`;
  const byDay = {};
  for (const e of list) (byDay[e.start.slice(0, 10)] ||= []).push(e);
  const from = addDays(today, 1), to = addDays(today, 7);
  const md = (x) => `${MONTHS[+x.slice(5, 7) - 1]} ${+x.slice(8)}`;
  const title = space.title || 'Family Calendar';
  const html = `<div style="font:16px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#14213d;max-width:560px">
    <h2 style="margin:0 0 4px">The week ahead</h2>
    <p style="margin:0 0 18px;color:#6b7280">${esc(title)} · ${md(from)} – ${md(to)}</p>
    ${list.length ? Object.keys(byDay).sort().map((day) => `<h3 style="margin:18px 0 6px;font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280">${WEEKDAYS[dow(day)]}, ${md(day)}</h3>
      ${byDay[day].map((e) => `<div style="padding:8px 12px;margin:0 0 6px;border-left:4px solid ${esc(calOf(e.cal).color || '#94a3b8')};background:#f6f5f1;border-radius:0 8px 8px 0">
        <b>${e.allDay ? 'All day' : esc(fmtTime(e.start))} · ${esc(e.title)}</b>${isMaybe(e) ? ' <span style="color:#6b7280">(maybe)</span>' : ''}
        ${e.location ? `<br><a style="color:#6b7280" href="https://maps.google.com/?q=${encodeURIComponent(e.location)}">📍 ${esc(place(e.location))}</a>` : ''}</div>`).join('')}`).join('')
      : '<p>Nothing on the calendar this week.</p>'}
    <p style="margin:24px 0 0"><a href="${link}" style="background:#e63946;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">Open the calendar</a></p>
    <p style="color:#9aa3b5;font-size:13px;margin-top:18px">Sent every Sunday by the family calendar. Practices aren’t included. Reply to this email to reach Sam &amp; Emily.</p></div>`;
  const text = `The week ahead — ${title}\n\n` + (list.length ? Object.keys(byDay).sort().map((day) => `${WEEKDAYS[dow(day)]}, ${md(day)}\n` + byDay[day].map((e) => `  ${e.allDay ? 'All day' : fmtTime(e.start)} · ${e.title}${e.location ? ' · ' + place(e.location) : ''}`).join('\n')).join('\n\n') : 'Nothing on the calendar this week.') + `\n\nOpen the calendar: ${link}`;
  if (DRY) { console.log(`[dry] weekly email to ${d.emails.length}:\n${text}`); return; }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: d.from, pass: d.appPassword } });
    await t.sendMail({ from: `"${title}" <${d.from}>`, to: d.from, bcc: d.emails, subject: `This week: ${list.length} event${list.length === 1 ? '' : 's'} (${md(from)} – ${md(to)})`, text, html });
    console.log(`Weekly email sent to ${d.emails.length}.`);
  } catch (err) { console.log(`⚠ Weekly email failed: ${err.message} — check the Gmail app password in Settings → Weekly email.`); }
}

/* ---------- save ---------- */
const cutoff = Date.now() - 3 * 86400e3;
state.sent = Object.fromEntries(Object.entries(state.sent).filter(([, t]) => t > cutoff));
state.dead = [...dead].filter((id) => subs.some((s) => s._id === id));
await writeFile(STATE_FILE, await encryptJSON(state, CAL_PASSCODE));
console.log(`${subs.length} phone(s) signed up · ${sentCount} notification(s) sent · ${Object.keys(snap).length} events watched.`);
