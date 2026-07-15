const CACHE_NAME = "grimodex-scan-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const hasPrivateCredential = ["authorization", "x-scan-token", "x-upload-token"].some((name) => event.request.headers.has(name));
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    hasPrivateCredential ||
    event.request.cache === "no-store"
  ) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && !response.headers.get("cache-control")?.includes("no-store")) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("./index.html"))),
  );
});
