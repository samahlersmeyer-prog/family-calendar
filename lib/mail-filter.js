// Decides whether something found in an email is a real "be somewhere" event,
// or noise: stock alerts, sales, receipts, deliveries, newsletters, logins.

const FINANCE = /\b(stocks?|shares|earnings|dividends?|portfolio|invest(ing|ment|ments|or|ors)?|crypto|bitcoin|ethereum|trading|trade alert|price target|nasdaq|s&p|dow jones|market (open|close|update)|401\(?k\)?|roth|mortgage rate|interest rate|ticker|options expir|watchlist)\b/i;
const SHOPPING = /(\d+\s?% off|\bsale\b|\bdeals?\b|\bdiscount|\bcoupon|\bpromo\b|\bpromo code|offer ends|shop now|buy now|free shipping|limited time|clearance|black friday|cyber monday|doorbuster|save \$|new arrivals|flash sale)/i;
const TRANSACTIONAL = /\b(order (#|no\.?|number|confirmed|confirmation|update)|your order|has shipped|shipment|shipping (update|confirmation)|out for delivery|delivered|delivery (window|update|scheduled)|arriving|tracking (number|#)|receipt|invoice|statement (is )?(ready|available)|payment (due|received|scheduled|reminder)|autopay|bill (is )?(ready|due)|subscription|renew(al|s)|verify your|verification code|one[- ]time (code|passcode)|password|security alert|sign[- ]in attempt|new (sign[- ]in|login)|account (alert|update)|refund|return label)\b/i;
const NEWSY = /\b(newsletter|webinar|podcast|digest|roundup|weekly update from|blog|survey|feedback|rate your|review your)\b/i;

// Senders/subjects that usually mean real-life plans.
const TRUSTED = /(pastor|rev\.|reverend|church|lutheran|catholic|school|academy|coach|teacher|homeroom|grade parents|factsmgt|renweb|parentsquare|remind\.com|seesaw|class dojo|classdojo|team\b|league|club\b|athletic|sportsyou|gamechanger|teamsnap|signupgenius|sign ?up genius|evite|paperless ?post|punchbowl|rsvp|invitation|invited|dentist|dental|doctor|pediatric|orthodont|clinic|appointment|birthday|party|recital|rehearsal|choir|tournament|holy cross|concordia|mad apple)/i;

export const EVENT = /\b(game|games|vs\.?|@|practice|scrimmage|tournament|match|meet|tip[- ]?off|kick[- ]?off|first pitch|warm[- ]?ups?|rehearsal|recital|concert|program|performance|show|choir|sing|singing|service|worship|chapel|mass|party|birthday|celebration|dinner|lunch|breakfast|brunch|cookout|potluck|appointment|appt|check[- ]?up|dentist|doctor|meeting|conference|open house|field trip|pick[- ]?up|drop[- ]?off|tryouts?|banquet|ceremony|graduation|wedding|shower|funeral|visitation|reunion|camp|clinic|lesson|class|workout|session|photos?|pictures?|picture day|game day|registration|sign[- ]?ups?|fundraiser|carnival|festival|play ?date|sleepover|field trip|showcase|assembly|retreat|tour|visit|fair|expo|museum|zoo|dismissal|early release|no school|testing|test day|open gym|confirmation|baptism|first communion|awards?|(?:concordia|spirit|picture|field|career|pajama|dress[- ]up|grandparents?|fun|half|snow) day)s?\b/i;

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
  const junk = !!reason && !hasInvite && !(trusted && EVENT.test(subject) && !FINANCE.test(subject));
  return { junk, reason, trusted, bulk, subjectEvent: EVENT.test(subject) };
}

/** Score one dated line from an email. Higher = more likely a real place to be. */
export function scoreRow({ title = '', line = '', time = null, location = '' }, mail) {
  const text = `${title} ${line}`;
  let s = 0;
  if (time) s += 3;
  if (EVENT.test(text)) s += 3;
  if (mail.trusted) s += 2;
  if (mail.subjectEvent && !EVENT.test(text)) s += 2; // the subject says what it is ("field trips")
  if (location || /\s(at|@)\s+[A-Z0-9]/.test(line)) s += 1;
  if (mail.bulk && !mail.trusted) s -= 3;
  if (FINANCE.test(text) || SHOPPING.test(text) || TRANSACTIONAL.test(text)) s -= 6;
  if (/\b(deadline|due|expires?|ends|last day to|by \d)/i.test(text)) s -= time ? 2 : 4;
  return s;
}

export const KEEP_SCORE = 5; // shown for review
export const CHECK_SCORE = 7; // shown already checked

const ABBR = /\b(vs|st|dr|mr|mrs|ms|jr|sr|no|ave|rd|blvd|hwy|mt|ft|a\.m|p\.m|etc|approx|dept)\.$/i;
/** Split prose into sentences without breaking "vs. St. Jude" or "Dr. Lee". */
export function splitSentences(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let buf = '';
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      buf = buf ? buf + ' ' + part : part;
      if (!ABBR.test(buf) && /[.!?]$/.test(buf)) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
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
    if (prev && prev.time && r.date === prev.date && !EVENT.test(r.line) && !/\d{1,2}\/\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i.test(r.line)) {
      prev.line += ' ' + r.line;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}
