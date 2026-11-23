// Keeps the app opening with no signal. The shell files are cached; the
// Firebase scripts are cached the first time they load. Trip data itself is
// kept offline by Firestore, not here.
const VERSION = 'svw-8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'trip-math.js', 'logic.js', 'categories.js', 'theme.js', 'insights.js', 'firebase-config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  // 'reload' skips the browser's own 10-minute cache, so a new version never installs stale files.
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin;
  const isSdk = (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@tabler/icons-webfont@')) || (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.startsWith('/ajax/libs/html2canvas/'));
  if (!isShell && !isSdk) return; // Firestore traffic etc. is left alone
  // Network first for our own files (so updates arrive), cache when offline;
  // the pinned SDK files never change, so cache first.
  if (isSdk) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }
  // 'no-cache' = always ask the server whether the file changed (cheap), instead of trusting the 10-minute cache.
  e.respondWith(
    fetch(req.url, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('./')))
  );
});
