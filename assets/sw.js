// The Pages workflow replaces this token with the immutable source commit before upload.
const CACHE_NAME = "litehouse-shell-__LITEHOUSE_CACHE_VERSION__";
const APP_ROOT = new URL("./", self.registration.scope).href;
const STATIC_DESTINATIONS = new Set(["font", "image", "script", "style", "worker"]);

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch(APP_ROOT, { cache: "reload" });
  if (!response.ok) throw new Error(`Litehouse shell returned ${response.status}`);

  const html = await response.clone().text();
  const scope = new URL(APP_ROOT);
  const assetUrls = Array.from(html.matchAll(/\b(?:src|href)="([^"]+)"/g), (match) => match[1])
    .map((value) => new URL(value, APP_ROOT))
    .filter((url) => url.origin === scope.origin && url.pathname.startsWith(scope.pathname))
    .map((url) => url.href);

  await cache.put(APP_ROOT, response);
  await cache.addAll([...new Set(assetUrls)]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("litehouse-shell-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method !== "GET"
    || url.origin !== self.location.origin
    || request.headers.has("range")
    || url.pathname.includes("/v1/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            void caches.open(CACHE_NAME).then((cache) => cache.put(APP_ROOT, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(APP_ROOT)),
    );
    return;
  }

  if (!STATIC_DESTINATIONS.has(request.destination)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      });
    }),
  );
});
