// Makes the calendar open fast and with no signal.
// - Versioned app files (…?v=26) and library files never change, so they come straight from the saved copy.
// - The page itself (index.html) is checked online, but if the network is slow we show the saved copy
//   after a moment and refresh it in the background.
// - Firestore keeps its own offline copy of the events.
const V = 33;
const CACHE = 'family-calendar-v' + V;
const LIBFILES = ['crypto', 'ics', 'schedule-text', 'tz', 'mail-filter', 'cloud', 'events', 'chores'].map((f) => `lib/${f}.js?v=${V}`);
const SHELL = ['./', 'index.html', `style.css?v=${V}`, `app.js?v=${V}`, ...LIBFILES, 'manifest.webmanifest', 'icon.png', 'icon-192.png'];
const FB = '10.12.2';
const FIREBASE = ['app', 'auth', 'firestore'].map((m) => `https://www.gstatic.com/firebasejs/${FB}/firebase-${m}.js`);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all([...SHELL, ...FIREBASE].map((u) => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const LIBS = /^(www\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/;
const save = (r, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); } return res; };
const cacheFirst = (r) => caches.match(r).then((hit) => hit || fetch(r).then((res) => save(r, res)));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const mine = u.origin === location.origin;
  if (LIBS.test(u.hostname)) return e.respondWith(cacheFirst(r));
  if (mine && u.searchParams.has('v')) return e.respondWith(cacheFirst(r)); // versioned: never changes
  if (mine && r.mode === 'navigate') {
    // Try the network for up to 1.5s, otherwise open the saved page right away (it updates in the background).
    const net = fetch(r).then((res) => save(r, res));
    e.waitUntil(net.catch(() => {}));
    return e.respondWith(caches.match(r, { ignoreSearch: true }).then((hit) => {
      if (!hit) return net.catch(() => caches.match('./'));
      return Promise.race([net.catch(() => hit), new Promise((res) => setTimeout(() => res(hit), 1500))]);
    }));
  }
  if (mine || u.hostname === 'raw.githubusercontent.com') {
    e.respondWith(fetch(r).then((res) => save(r, res)).catch(() => caches.match(r, { ignoreSearch: u.hostname === 'raw.githubusercontent.com' }).then((hit) => hit || Response.error())));
  }
  // Everything else (Firestore, Google sign-in, Gmail) goes straight to the network.
});

// Phone notifications sent by the GitHub Action (scripts/notify.mjs).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Family Calendar', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Family Calendar', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    if (open) { open.focus(); return open.navigate ? open.navigate(url).catch(() => {}) : null; }
    return self.clients.openWindow(url);
  }));
});
