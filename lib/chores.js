// Chores by the day. A chore repeats once, every day, every week, or on certain weekdays (days: [0..6], Sunday = 0).
import { todayWall, addDays, dow } from './tz.js?v=40';

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const REPEAT_CHORE = { '': 'Once', day: 'Every day', days: 'Certain days', week: 'Every week' };

const weekStart = (d) => addDays(d, -dow(d));

/** Done? Repeating chores reset on their own each day (or each week for weekly ones). */
export function itemDone(i) {
  if (!i.repeat) return !!i.done;
  const t = todayWall();
  return !!i.doneOn && (i.repeat === 'week' ? i.doneOn >= weekStart(t) : i.doneOn === t);
}

/** Is this chore on the list for a weekday (0–6)? Only "certain days" chores skip days. */
export const dueOn = (i, wd) => i.repeat !== 'days' || (Array.isArray(i.days) && i.days.includes(wd));
export const dueToday = (i) => dueOn(i, dow(todayWall()));

/** "Every day", "Mon · Wed · Fri", "Weekdays"… for the little line under a chore. */
export function repeatLabel(i) {
  if (i.repeat !== 'days') return i.repeat ? REPEAT_CHORE[i.repeat] || '' : '';
  const d = [...(i.days || [])].sort();
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  if (d.join() === '1,2,3,4,5,6') return 'Mon–Sat';
  if (d.join() === '0,6') return 'Weekends';
  if (d.length === 7) return 'Every day';
  return d.map((x) => DAY_SHORT[x]).join(' · ');
}

/**
 * Suggested starter chores, by age. Fridays stay light (evening workouts) and Sundays are off.
 * Only kids who are on the calendar get chores.
 */
export function starterChores(kids) {
  const plan = {
    Max: [
      ['Make bed & tidy room', [1, 2, 3, 4, 5, 6]],
      ['Unload the dishwasher', [1, 4]],
      ['Trash & recycling out', [1]],
      ['Wash, fold & put away your laundry', [2]],
      ['Clean the kids’ bathroom (toilet, sink, mirror)', [4]],
      ['Big job with Dad (yard, garage or car)', [6]],
    ],
    Theo: [
      ['Make bed & tidy room', [1, 2, 3, 4, 5, 6]],
      ['Unload the dishwasher', [2, 5]],
      ['Vacuum the living room', [1]],
      ['Load the dishwasher after dinner', [3]],
      ['Bring trash cans back in', [2]],
      ['Sweep the kitchen floor', [6]],
    ],
    Junie: [
      ['Make bed & tidy room', [1, 2, 3, 4, 5, 6]],
      ['Unload the dishwasher', [3, 6]],
      ['Wipe bathroom sinks & mirrors', [1]],
      ['Set the table for dinner', [2, 4]],
      ['Dust the living room', [4]],
      ['Fold & put away towels', [6]],
    ],
    Louie: [
      ['Make bed & put shoes and backpack away', [1, 2, 3, 4, 5]],
      ['Match socks from the laundry', [2]],
      ['Clear the table after dinner', [1, 3]],
      ['Put away your clean clothes', [4]],
      ['Pick up toys in the family room', [6]],
    ],
    Josie: [
      ['Make bed & dirty clothes in the hamper', [1, 2, 3, 4, 5]],
      ['Put out napkins & forks for dinner', [1, 3]],
      ['Water the plants', [2]],
      ['Put away your clean clothes', [4]],
      ['Wipe the table after lunch', [6]],
    ],
  };
  return kids.filter((k) => plan[k]).flatMap((k) => plan[k].map(([text, days]) => ({ who: k, text, repeat: 'days', days })));
}

/* ---------- morning routine ---------- */
// Same checklist for every kid, saved as list 'am' items (one per kid + step) so each kid checks off their own.
// They reset every morning like daily chores. School mornings (Mon–Fri) unless picked otherwise.
export const MORNING_LIB = ['Fill water bottle', 'Eat breakfast', 'Brush teeth', 'Pack a snack'];
export const MORNING_DAYS = [1, 2, 3, 4, 5];
/**
 * What the Today list and the kitchen display show first: the morning routine until 11am,
 * then chores — or chores as soon as every kid has checked off this morning's routine.
 */
export function autoMode(wallNow, items = []) {
  if (+wallNow.slice(11, 13) >= 11) return 'todo';
  const am = items.filter((i) => i.list === 'am' && dueToday(i));
  return am.length && am.every(itemDone) ? 'todo' : 'am';
}

/* ---------- chore chart ---------- */
export const CHORE_LIB = ['Dishes', 'Trash', 'Vacuum', 'Laundry', 'Clean kitchen', 'Clean Wreck It Room', 'Feed the dogs', 'Make bed', 'Clean room'];
const ICONS = [[/bottle|drink/i, '💧'], [/breakfast/i, '🥣'], [/teeth|tooth/i, '🦷'], [/snack/i, '🍎'], [/dress/i, '👕'], [/dish/i, '🍽️'], [/trash|garbage|recycl/i, '🗑️'], [/vacuum|sweep|mop/i, '🧹'], [/laundry|clothes|socks|towel|fold/i, '🧺'],
  [/kitchen|counter/i, '🧽'], [/wreck|basement|play ?room|toys/i, '🎮'], [/dog|pet|feed/i, '🐶'], [/bed/i, '🛏️'], [/room/i, '🧸'],
  [/bath|toilet/i, '🛁'], [/table/i, '🍴'], [/yard|mow|rake|leaves|snow/i, '🍂'], [/plant|water/i, '🪴'], [/car/i, '🚗'], [/read|homework/i, '📚'], [/attic|garage|closet|storage/i, '📦'], [/practice|piano|instrument/i, '🎵'],
  [/shoe/i, '👟'], [/backpack/i, '🎒']];
export const choreIcon = (text) => (ICONS.find(([re]) => re.test(text)) || [, '⭐'])[1];
const key = (s) => s.trim().toLowerCase();

/** Which chores a kid has on a weekday (chart chores plus any "every day" ones). */
export const choresFor = (items, kid, wd) => items.filter((i) => i.list === 'todo' && i.who === kid && (i.repeat === 'day' || (i.repeat === 'days' && (i.days || []).includes(wd))));

/**
 * The change to make when a chore is put on (or taken off) a kid's day.
 * Returns { put: item | null, del: id | null }. One item per kid + chore holds all of its days.
 */
export function setChoreDay(items, kid, text, wds, on, make) {
  const it = items.find((i) => i.list === 'todo' && i.who === kid && key(i.text) === key(text) && (i.repeat === 'days' || i.repeat === 'day'));
  const had = it ? (it.repeat === 'day' ? [0, 1, 2, 3, 4, 5, 6] : it.days || []) : [];
  const days = [...new Set(on ? [...had, ...wds] : had.filter((d) => !wds.includes(d)))].sort();
  if (!it) return days.length ? { put: make({ who: kid, text, repeat: 'days', days }) } : {};
  if (!days.length) return { del: it.id };
  return { put: { ...it, repeat: 'days', days } };
}

/** The chore's emoji as a picture (emoji/ folder, from Twemoji) for screens without an emoji font, like the Echo's browser. */
export const choreIconImg = (text, base = '') => {
  const code = [...choreIcon(text)].map((c) => c.codePointAt(0)).filter((c) => c !== 0xfe0f).map((c) => c.toString(16)).join('-');
  return `<img class="cem" src="${base}emoji/${code}.svg" alt="" width="20" height="20">`;
};
