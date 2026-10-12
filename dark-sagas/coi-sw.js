// Cross-origin isolation for hosts that cannot send headers (GitHub Pages).
// SuperCollider's WebAssembly build needs SharedArrayBuffer, which browsers only enable when the
// page is served with COOP: same-origin + COEP: require-corp. This service worker adds those
// headers to every response it handles. Its scope is the folder it is served from, so it can
// never affect other designs on the same site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
  event.respondWith((async () => {
    const res = await fetch(req);
    if (res.status === 0) return res; // opaque response: cannot be modified
    const headers = new Headers(res.headers);
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
