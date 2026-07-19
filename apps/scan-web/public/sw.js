const CACHE_PREFIX = "grimodex-scan-shell-";
const CACHE_NAME = `${CACHE_PREFIX}__GRIMODEX_SCAN_BUILD__`;
const INDEX_URL = "/index.html";
const STATIC_SHELL = ["/", "/manifest.webmanifest"];

function discoverBuildAssets(html) {
  const assets = new Set();
  const attributePattern = /(?:src|href)=["']([^"']+)["']/giu;
  for (const match of html.matchAll(attributePattern)) {
    const value = match[1];
    if (!value) continue;
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) continue;
    if (!/\.(?:css|js|mjs)$/iu.test(url.pathname)) continue;
    assets.add(`${url.pathname}${url.search}`);
  }
  return [...assets];
}

async function discoverStylesheetFonts(buildAssets) {
  const fonts = new Set();
  const urlPattern = /url\(\s*(?:["']([^"']+)["']|([^)'"\s]+))\s*\)/giu;
  for (const asset of buildAssets) {
    const stylesheetUrl = new URL(asset, self.location.origin);
    if (!stylesheetUrl.pathname.endsWith(".css") || stylesheetUrl.search)
      continue;
    const response = await fetch(asset, { cache: "reload" });
    if (!response.ok) throw new Error("Unable to inspect the app stylesheet");
    const css = await response.text();
    for (const match of css.matchAll(urlPattern)) {
      const value = match[1] ?? match[2];
      if (!value) continue;
      const url = new URL(value, stylesheetUrl);
      if (
        url.origin !== self.location.origin ||
        !url.pathname.startsWith("/assets/") ||
        url.search !== "" ||
        !/\.(?:woff2?|ttf|otf)$/iu.test(url.pathname)
      )
        continue;
      fonts.add(url.pathname);
    }
  }
  return [...fonts];
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch(INDEX_URL, { cache: "reload" });
  if (!indexResponse.ok) throw new Error("Unable to precache the app shell");
  const html = await indexResponse.clone().text();
  const buildAssets = discoverBuildAssets(html);
  const fontAssets = await discoverStylesheetFonts(buildAssets);
  await cache.put(INDEX_URL, indexResponse);
  await cache.addAll([...STATIC_SHELL, ...buildAssets, ...fontAssets]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const hasPrivateCredential = [
    "authorization",
    "x-scan-token",
    "x-upload-token",
  ].some((name) => event.request.headers.has(name));
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    hasPrivateCredential ||
    event.request.cache === "no-store"
  )
    return;
  const cachedFallback = async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate") {
      const shell = await cache.match(INDEX_URL);
      if (shell) return shell;
    }
    return undefined;
  };
  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (!response.ok) return (await cachedFallback()) ?? response;
        const isStaticBuildAsset =
          url.pathname.startsWith("/assets/") &&
          url.search === "" &&
          /\.(?:css|js|mjs|woff2?|ttf|otf)$/iu.test(url.pathname);
        if (
          isStaticBuildAsset &&
          !response.headers.get("cache-control")?.includes("no-store")
        ) {
          const copy = response.clone();
          void caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => undefined);
        }
        return response;
      })
      .catch(async (cause) => {
        const fallback = await cachedFallback();
        if (fallback) return fallback;
        throw cause;
      }),
  );
});
