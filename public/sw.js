/* Service worker do cardápio: abre mesmo sem internet depois da primeira visita.
 * - Casca da app (HTML/CSS/JS): cache primeiro, atualiza em segundo plano.
 * - Menu (/api/menu): rede primeiro, cai para a última cópia guardada.
 * - Imagens (/media): cache primeiro. Vídeos e pedidos parciais (Range) passam direto.
 * - Painel e restante API: nunca em cache.
 */
const VERSION = "cardapio-v6";
const SHELL = ["/index.html", "/styles.css?v=6", "/themes.css?v=6", "/app.js?v=6", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;

  if (p.startsWith("/painel") || p === "/health" || p.startsWith("/api/") && p !== "/api/menu") return;

  if (p === "/api/menu") return void event.respondWith(networkFirst(req));

  // Páginas do cardápio (/ e /r/<slug>): mostra a casca guardada se estiver offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/index.html")));
    return;
  }

  if (p.startsWith("/media/")) {
    if (/\.(mp4|webm)$/i.test(p)) return;
    return void event.respondWith(cacheFirst(req));
  }

  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok && res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}
