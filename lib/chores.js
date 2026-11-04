// Chores by the day. A chore repeats once, every day, every week, or on certain weekdays (days: [0..6], Sunday = 0).
import { todayWall, addDays, dow } from './tz.js?v=28';

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
