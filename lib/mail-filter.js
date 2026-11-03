// Decides whether something found in an email is a real "be somewhere" event,
// or noise: stock alerts, sales, receipts, deliveries, newsletters, logins.

const FINANCE = /\b(stocks?|shares|earnings|dividends?|portfolio|invest(ing|ment|ments|or|ors)?|crypto|bitcoin|ethereum|trading|trade alert|price target|nasdaq|s&p|dow jones|market (open|close|update)|401\(?k\)?|roth|mortgage rate|interest rate|ticker|options expir|watchlist)\b/i;
const SHOPPING = /(\d+\s?% off|\bsale\b|\bdeals?\b|\bdiscount|\bcoupon|\bpromo\b|\bpromo code|offer ends|shop now|buy now|free shipping|limited time|clearance|black friday|cyber monday|doorbuster|save \$|new arrivals|flash sale)/i;
const TRANSACTIONAL = /\b(order (#|no\.?|number|confirmed|confirmation|update)|your order|has shipped|shipment|shipping (update|confirmation)|out for delivery|delivered|delivery (window|update|scheduled)|arriving|tracking (number|#)|receipt|invoice|statement (is )?(ready|available)|payment (due|received|scheduled|reminder)|autopay|bill (is )?(ready|due)|subscription|renew(al|s)|verify your|verification code|one[- ]time (code|passcode)|password|security alert|sign[- ]in attempt|new (sign[- ]in|login)|account (alert|update)|refund|return label)\b/i;
const NEWSY = /\b(newsletter|webinar|podcast|digest|roundup|weekly update from|blog|survey|feedback|rate your|review your)\b/i;

// Tickets you bought are real plans, even though the email is a "receipt".
export const TICKETS = /\b(e-?tickets?|tickets?|admission|will call|general admission|doors open|showtime|row [a-z0-9]{1,3},? seats? \d+|seats? \d+)\b/i;

// Senders/subjects that usually mean real-life plans.
const TRUSTED = /(pastor|rev\.|reverend|church|lutheran|catholic|school|academy|coach|teacher|homeroom|grade parents|factsmgt|renweb|parentsquare|remind\.com|seesaw|class dojo|classdojo|team\b|league|club\b|athletic|sportsyou|gamechanger|teamsnap|signupgenius|sign ?up genius|evite|paperless ?post|punchbowl|rsvp|invitation|invited|dentist|dental|doctor|pediatric|orthodont|clinic|appointment|birthday|party|recital|rehearsal|choir|tournament|holy cross|concordia|mad apple)/i;

export const EVENT = /\b(game|games|vs\.?|@|practice|scrimmage|tournament|match|meet|tip[- ]?off|kick[- ]?off|first pitch|warm[- ]?ups?|rehearsal|recital|concert|program|performance|show|choir|sing|singing|service|worship|chapel|mass|party|birthday|celebration|dinner|lunch|breakfast|brunch|cookout|potluck|appointment|appt|check[- ]?up|dentist|doctor|meeting|conference|open house|field trip|pick[- ]?up|drop[- ]?off|tryouts?|banquet|ceremony|graduation|wedding|shower|funeral|visitation|reunion|camp|clinic|lesson|class|workout|session|photos?|pictures?|picture day|game day|registration|sign[- ]?ups?|fundraiser|carnival|festival|play ?date|sleepover|field trip|showcase|assembly|retreat|tour|visit|fair|expo|museum|zoo|dismissal|early release|no school|testing|test day|open gym|confirmation|baptism|first communion|awards?|snacks?|snack (leader|parent|helper|duty|day)|treats?|volunteer(ing)?|helper|duty|chaperone|room parent|lunch duty|recess duty|concessions?|(?:concordia|spirit|picture|field|career|pajama|dress[- ]up|grandparents?|fun|half|snow) day)s?\b/i;

/** Look at the whole email once. */
export function classifyMail({ subject = '', from = '', body = '', bulk = false, hasInvite = false }) {
  const head = `${subject} ${from}`;
  const sample = body.slice(0, 2500);
  const trusted = TRUSTED.test(head) || TRUSTED.test(sample.slice(0, 600));
  let reason = '';
  if (FINANCE.test(subject) || (sample.match(new RegExp(FINANCE.source, 'gi')) || []).length >= 3) reason = 'finance';
  else if (SHOPPING.test(subject)) reason = 'shopping';
  else if (TRANSACTIONAL.test(subject)) reason = 'receipt/delivery/account';
  else if (bulk && !trusted && (SHOPPING.test(sample) || NEWSY.test(head) || FINANCE.test(sample))) reason = 'marketing';
  const ticket = !FINANCE.test(subject) && !SHOPPING.test(subject) && (TICKETS.test(subject) || (sample.match(new RegExp(TICKETS.source, 'gi')) || []).length >= 2);
  const junk = !!reason && !hasInvite && !ticket && !(trusted && EVENT.test(subject) && !FINANCE.test(subject));
  return { junk, reason, trusted, bulk, ticket, subjectEvent: EVENT.test(subject) };
}

/** Score one dated line from an email. Higher = more likely a real place to be. */
export function scoreRow({ title = '', line = '', time = null, location = '' }, mail) {
  const text = `${title} ${line}`;
  let s = 0;
  if (time) s += 3;
  if (EVENT.test(text)) s += 3;
  if (mail.trusted) s += 2;
  if (mail.ticket) s += 3;
  if (mail.subjectEvent && !EVENT.test(text)) s += 2; // the subject says what it is ("field trips")
  if (location || /\s(at|@)\s+[A-Z0-9]/.test(line)) s += 1;
  if (mail.bulk && !mail.trusted) s -= 3;
  if (FINANCE.test(text) || SHOPPING.test(text) || (!mail.ticket && TRANSACTIONAL.test(text))) s -= 6;
  if (/\b(deadline|due|expires?|ends|last day to|by \d)/i.test(text)) s -= time ? 2 : 4;
  return s;
}

export const KEEP_SCORE = 5; // shown for review
export const CHECK_SCORE = 7; // shown already checked

const ABBR = /\b(vs|st|dr|mr|mrs|ms|jr|sr|no|ave|rd|blvd|hwy|mt|ft|a\.m|p\.m|etc|approx|dept)\.$/i;
const MON_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/i;
/** Emails wrap long sentences at ~75 characters; put them back together (short schedule lines stay as they are). */
export function unwrap(text) {
  const lines = text.split('\n');
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.length >= 55 && l.trim() && !/[.!?:]$/.test(prev.trim()) && !/^\s*([-*•]|\d{1,2}(:\d\d)?\s*[ap]m)/i.test(l)) out[out.length - 1] = prev.trimEnd() + ' ' + l.trim();
    else out.push(l);
  }
  return out.join('\n');
}
/** Split prose into sentences without breaking "vs. St. Jude" or "Dr. Lee". */
export function splitSentences(text) {
  const out = [];
  for (const line0 of unwrap(text).split('\n')) {
    // "rehearsal is on April 28 and the concert is on April 29" → two lines, one date each
    const line = MON_DAY.test(line0) ? line0.replace(/,?\s+and\s+(?=[^.]*?(\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d|\d{1,2}\/\d{1,2}))/gi, (...a) => (MON_DAY.test(a[a.length - 1].slice(0, a[a.length - 2])) ? '.\n' : a[0])) : line0;
    for (const ln of line.split('\n')) {
      let buf = '';
      for (const part of ln.split(/(?<=[.!?])\s+/)) {
        buf = buf ? buf + ' ' + part : part;
        if (!ABBR.test(buf) && /[.!?]$/.test(buf)) { out.push(buf); buf = ''; }
      }
      if (buf) out.push(buf);
    }
  }
  return out.join('\n');
}

/** "Our game is Monday, Nov 2." + "Tip-off is at 4:30." → one event at 4:30. */
export function mergeRows(rows) {
  const out = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && !prev.time && r.time && r.date === prev.date) {
      prev.time = r.time; prev.endTime = r.endTime; prev.line += ' ' + r.line;
      if (!prev.location && r.location) prev.location = r.location;
      continue;
    }
    // "Our time to be there is 9:30-11:30" right after an event that already has a time = detail, not a new event
    if (prev && prev.time && r.date === prev.date && !r.header && !EVENT.test(r.line) && !/\d{1,2}\/\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i.test(r.line)) {
      prev.line += ' ' + r.line;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

const PHASE = /^(call time|arrival( time)?|arrive|report( time)?|doors( open)?|warm[- ]?ups?|check[- ]?in|(concert|show|program|game|event|service|performance)?\s*(starts?|begins?|start time)|(approx\.?\s*)?(concert|show|program|game|event|performance)?\s*(ends?|end time|over)|dismiss(al)?|pick[- ]?up)$/i;
const cap = (t) => t.replace(/\b\w/g, (c) => c.toUpperCase());
function singular(w) { return w.replace(/ies$/i, 'y').replace(/(s)$/i, (m, s1, o, str) => (/(ss|us)$/i.test(str) ? s1 : '')); }

/** "Elementary Band Rehearsal and Concert - November 11 & 12" → "Elementary Band" (what it's about). */
export function subjectCore(subject) {
  return String(subject || '').replace(/^((re|fwd?|fw):\s*)+/i, '').split(/\s+[-–—|:]\s+/)[0]
    .replace(new RegExp(EVENT.source, 'gi'), ' ').replace(/\b(and|&|reminders?|info(rmation)?|update|schedule|this|next|today|tonight|tomorrow|(mon|tues|wednes|thurs|fri|satur|sun)day|(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{1,2})?)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

/**
 * Turn schedule rows that sit under a date heading into real events:
 *  "Thursday, Nov 12 - CONCERT" + "6:30 call time / 7:00 starts / 8:00 end" → one "Elementary Band Concert", 6:30–8:00
 *  "Wednesday, Nov 11 - REHEARSALS" + "5:30-6:15 Band Blazers" → "Elementary Band Rehearsal – Band Blazers"
 */
export function groupRows(rows, subject = '') {
  const core = subjectCore(subject);
  const name = (h) => {
    const head = cap(singular(h.toLowerCase().trim()));
    // "Elementary Band" + "Concert" only when the subject is about that ("…Rehearsal and Concert")
    const about = String(subject).toLowerCase().includes(singular(h.toLowerCase().trim()).slice(0, 6));
    return core && about && !head.toLowerCase().includes(core.toLowerCase()) ? `${core} ${head}` : head;
  };
  const out = [];
  const groups = new Map();
  for (const r of rows) {
    // a heading (or a subject line) with timed rows on the same day is replaced by them
    if ((r.heading || (r.prose && r.title.length > 40)) && rows.some((x) => x !== r && x.date === r.date && x.time && x.line !== r.line)) continue;
    if (r.heading && r.title.length <= 40) {
      out.push({ ...r, title: name(r.title) });
      continue;
    }
    if (r.header && r.time && PHASE.test(r.title.trim())) {
      const k = r.date + '|' + r.header;
      let g = groups.get(k);
      if (!g) { g = { ...r, title: name(r.header), endTime: null, notes: [], line: '' }; groups.set(k, g); out.push(g); }
      if (/end|over|dismiss|pick/i.test(r.title)) g.endTime = r.time;
      else if (r.time < g.time) g.time = r.time;
      g.notes.push(`${r.title} ${r.line.match(/\d{1,2}(:\d\d)?\s*[ap]m/i)?.[0] || ''}`.trim());
      g.line += (g.line ? ' / ' : '') + r.line;
      continue;
    }
    if (r.header && r.title) { out.push({ ...r, title: `${name(r.header)} – ${r.title}` }); continue; }
    // prose like "the rehearsals will be on Wednesday, April 28" → "Elementary Band Rehearsal"
    const evs = r.title.match(new RegExp(EVENT.source, 'gi'));
    if (evs && !r.time && (/\b(will be|is|are|was|were)\b/i.test(r.title) || /^(the|our|on|and|this|a|an)\b/i.test(r.title))) {
      const at = r.title.match(/\bat\s+([A-Z].{3,80})$/);
      out.push({ ...r, title: name(evs[evs.length - 1]), location: r.location || (at ? at[1].replace(/[()]/g, '').replace(/\s{2,}/g, ' ').trim() : '') });
      continue;
    }
    out.push(r);
  }
  for (const g of groups.values()) { g.notes = g.notes.join(' · '); if (g.endTime && g.endTime <= g.time) g.endTime = null; }
  return out;
}
