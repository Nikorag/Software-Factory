// Service worker: makes the hub installable, keeps the app shell available offline, and shows push notifications.
// It never caches API responses, sign-in, or the per-factory dashboards (/f/...): those are live and per-user.
const CACHE = "sfhub-shell-v1";
const SHELL = ["/", "/app.js", "/style.css", "/favicon.png", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first, so a new release shows up immediately; the cache is only the offline fallback.
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* a push with no usable payload still gets a generic notification below */ }
  const str = (v, fallback) => (typeof v === "string" && v ? v.slice(0, 200) : fallback);
  e.waitUntil(self.registration.showNotification(str(d.title, "Software Factory"), {
    body: str(d.body, ""), tag: str(d.tag, "factory"), icon: "/icon-192.png", badge: "/favicon.png",
    data: { url: typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/" }, // same-origin paths only
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (wins) => {
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) { await w.focus(); return "navigate" in w ? w.navigate(target) : undefined; }
    return self.clients.openWindow(target);
  }));
});
