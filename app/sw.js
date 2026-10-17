// NEXY SUMMIT 2027 当日ガイド：オフラインでも開けるようにするための保存処理
const V = "nexy27-v1";
const SHELL = ["/app/", "/app/manifest.webmanifest", "/app/icon-192.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const netFirst = async (req) => {
  const c = await caches.open(V);
  try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
  catch (e) { const hit = await c.match(req, { ignoreVary: true }); if (hit) return hit; throw e; }
};
const cacheFirst = async (req) => {
  const c = await caches.open(V);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
};
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin && u.pathname === "/api/summit") {
    const a = u.searchParams.get("a");
    if (a === "photo") return e.respondWith(cacheFirst(req));
    if (a === "notices" || a === "people" || a === "me") return e.respondWith(netFirst(req));
    return;
  }
  if (req.mode === "navigate" && u.pathname.startsWith("/app")) return e.respondWith(netFirst(new Request("/app/")));
  if (u.origin === location.origin && u.pathname.startsWith("/app/")) return e.respondWith(netFirst(req));
  if (u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com") return e.respondWith(cacheFirst(req));
});
