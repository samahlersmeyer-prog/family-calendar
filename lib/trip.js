// "Leave by" times and game-day weather. Free services, no keys:
//   places → map spots: OpenStreetMap Nominatim (saved on the phone, so each place is looked up once)
//   drive time: OSRM          weather: Open-Meteo (the kitchen display already uses it)
// Everything here fails quietly — if a lookup doesn't work the card just doesn't show the extra line.
import { addMinutes, diffMinutes, utcToWall } from './tz.js?v=44';

const HOME = { lat: 41.08, lon: -85.14 }; // Fort Wayne: used for weather when a place can't be found
const TZ = 'America%2FIndiana%2FIndianapolis';
const mem = new Map();
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem('fc:' + k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('fc:' + k, JSON.stringify(v)); } catch {} },
};
const once = (key, fn) => { if (!mem.has(key)) mem.set(key, fn().catch(() => { mem.delete(key); return null; })); return mem.get(key); };

/* ---------- where is it? ---------- */
let lastGeo = 0;
const politely = async () => { const wait = lastGeo + 1100 - Date.now(); lastGeo = Math.max(Date.now(), lastGeo + 1100); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); };
async function nominatim(q) {
  await politely();
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-85.7,41.5,-84.6,40.7&q=${encodeURIComponent(q)}`;
  const j = await (await fetch(u, { headers: { Accept: 'application/json' } })).json();
  return j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null;
}
/** "Holy Cross Lutheran School, 3425 Crescent Ave, Fort Wayne" → a spot on the map (or null). */
export function geocode(loc) {
  const place = String(loc || '').replace(/\s+/g, ' ').trim();
  if (place.length < 4) return Promise.resolve(null);
  const key = 'geo:' + place.toLowerCase();
  const saved = ls.get(key);
  if (saved && (saved.lat || Date.now() - saved.at < 7 * 864e5)) return Promise.resolve(saved.lat ? saved : null);
  return once(key, async () => {
    const parts = place.split(/\s*,\s*/);
    const local = /\b(IN|Indiana|OH|Ohio|MI|Michigan)\b/.test(place) || /fort wayne/i.test(place) ? '' : ', Fort Wayne, IN';
    const tries = [...new Set([place, parts.length > 1 ? parts.slice(1).join(', ') : '', parts[0] + local].filter((q) => q && q.length > 3))];
    for (const q of tries) {
      const hit = await nominatim(q).catch(() => null);
      if (hit) { ls.set(key, { ...hit, at: Date.now() }); return hit; }
    }
    ls.set(key, { at: Date.now() });
    return null;
  });
}

/* ---------- when do we need to leave? ---------- */
/** Where this phone is right now (only if location was already allowed, or ask = true). */
export async function here(ask = false) {
  if (!navigator.geolocation) return null;
  if (!ask) {
    try { if ((await navigator.permissions.query({ name: 'geolocation' })).state !== 'granted') return null; } catch { return null; }
  }
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null), { maximumAge: 10 * 60e3, timeout: 10e3 }));
}
async function driveMinutes(from, to) {
  const r = (n) => n.toFixed(3);
  const key = `drive:${r(from.lat)},${r(from.lon)}>${r(to.lat)},${r(to.lon)}`;
  const saved = ls.get(key);
  if (saved && Date.now() - saved.at < 30 * 60e3) return saved.min;
  return once(key, async () => {
    const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`)).json();
    const sec = j.routes?.[0]?.duration;
    if (!sec) return null;
    const min = Math.max(3, Math.round((sec * 1.15) / 60)); // map times run a little optimistic
    ls.set(key, { min, at: Date.now() });
    return min;
  });
}
/** { leave: '2026-11-13T17:35', drive: 18 } — leave with 5 minutes to spare, rounded down to the 5 minutes. */
export async function leaveBy(e, ask = false, fromAddress = '') {
  if (!e.location || e.allDay) return null;
  // From where this phone is, or (kitchen display) from the home address saved in Settings.
  const [to, from] = await Promise.all([geocode(e.location), fromAddress ? geocode(fromAddress) : here(ask)]);
  if (!to || !from) return null;
  const drive = await driveMinutes(from, to);
  if (!drive || drive > 6 * 60) return null;
  let leave = addMinutes(e.start, -(drive + 5));
  const m = +leave.slice(14, 16);
  leave = addMinutes(leave, -(m % 5));
  return { leave, drive, late: leave < utcToWall(new Date()) };
}

/* ---------- game-day weather ---------- */
const OUT = /\b(baseball|softball|soccer|football|cross ?country|xc|track|golf|lacrosse|tennis|t-?ball|picnic|parade|pumpkin|hayride|fair|5k|run|race|tailgate|zoo)\b/i;
const IN = /\b(indoor|gym|gymnasium|fieldhouse|dome|mad apple|facility|cage|cages|lesson|clinic|workout|rec center|arena|coliseum|church|school program|concert|rehearsal)\b/i;
/** Is this probably outside? Sports and outings yes; gyms, cages, lessons and anything at Mad Apple no. */
export const isOutdoor = (e, cal) => !e.allDay && OUT.test(`${e.title} ${cal?.name || ''}`) && !IN.test(`${e.title} ${e.location || ''}`);

const WX = [[[0], '☀️'], [[1], '🌤️'], [[2], '⛅'], [[3], '☁️'], [[45, 48], '🌫️'], [[51, 53, 55, 56, 57], '🌦️'], [[61, 63, 80, 81], '🌧️'],
  [[65, 82], '🌧️'], [[66, 67], '🧊'], [[71, 73, 77, 85], '🌨️'], [[75, 86], '❄️'], [[95, 96, 99], '⛈️']];
async function hourly(at) {
  const key = `wx:${at.lat.toFixed(1)},${at.lon.toFixed(1)}`;
  const saved = ls.get(key);
  if (saved && Date.now() - saved.at < 60 * 60e3) return saved.h;
  return once(key, async () => {
    const q = `latitude=${at.lat.toFixed(2)}&longitude=${at.lon.toFixed(2)}&hourly=temperature_2m,precipitation_probability,weather_code&temperature_unit=fahrenheit&timezone=${TZ}&forecast_days=10`;
    const h = (await (await fetch('https://api.open-meteo.com/v1/forecast?' + q)).json()).hourly;
    if (!h?.time) return null;
    ls.set(key, { h, at: Date.now() });
    return h;
  });
}
/** { icon: '🌤️', temp: 58, rain: 20 } for the hour the event starts, if it's within the forecast. */
export async function weatherFor(e) {
  const days = diffMinutes(utcToWall(new Date()), e.start) / 1440;
  if (days < -0.2 || days > 9) return null;
  const at = (await geocode(e.location)) || HOME;
  const h = await hourly(at);
  if (!h) return null;
  const i = h.time.indexOf(e.start.slice(0, 13) + ':00');
  if (i < 0) return null;
  const icon = (WX.find(([cs]) => cs.includes(h.weather_code[i])) || [0, '🌡️'])[1];
  return { icon, temp: Math.round(h.temperature_2m[i]), rain: h.precipitation_probability[i] ?? 0 };
}
