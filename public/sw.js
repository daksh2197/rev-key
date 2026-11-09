/*
 * The service worker: a small script the browser keeps on the phone for this site.
 * Its one job is to save a copy of the app so the dashboard opens with no signal,
 * which is exactly where a car is parked (a garage, a parking lot, a road with no coverage).
 *
 * VERSION and FILES are filled in by scripts/stamp-sw.mjs at build time.
 * A new build gets a new VERSION, and that is what tells phones to throw away
 * the old copy and save the new one.
 */

const VERSION = '__VERSION__';
const CACHE = `open-gauge-${VERSION}`;
const FILES = ['__FILES__'];

// First visit: save every file the app needs.
// { cache: 'reload' } means "fetch a fresh copy, ignore what the browser already has".
// Without it a new version could save last week's page next to this week's code.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// New version installed: delete the copies saved by older versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('open-gauge-') && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const sameSite = new URL(request.url).origin === self.location.origin;
  if (request.method !== 'GET' || !sameSite) return;

  if (request.mode === 'navigate') {
    // The page itself: ask the network first, so an update shows up as soon as the host serves it.
    // No signal? Hand back the saved copy.
    event.respondWith(fetch(request).catch(() => caches.match('./')));
    return;
  }

  // Code, fonts and icons: the saved copy is instant, so use it. Network only if it's missing.
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((saved) => saved ?? fetch(request)));
});
