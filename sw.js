// Lets the calendar open with no signal. App files: network first, saved copy if offline.
// Library files (versioned URLs): saved copy first. Firestore keeps its own offline copy.
const CACHE = 'family-calendar-v19';
const SHELL = ['./', 'index.html', 'style.css?v=19', 'app.js?v=19', 'manifest.webmanifest', 'icon.png', 'icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const LIBS = /^(www\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/;
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const mine = u.origin === location.origin || u.hostname === 'raw.githubusercontent.com';
  if (!mine && !LIBS.test(u.hostname)) return; // Firestore, Google sign-in, Gmail: always live
  if (LIBS.test(u.hostname)) {
    e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(r).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r).then((hit) => hit || (r.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
