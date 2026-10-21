// sw.js — The Chocolate Story service worker.
// • Same-origin GET requests only. Firestore, Firebase Auth, fonts, Cloudinary images, Razorpay and the secure backend are
//   cross-origin and are NEVER intercepted or cached, so no customer data, tokens or payment traffic touch this cache.
// • Pages/scripts/styles: network-first (always fresh when online; cached copy only as an offline/slow-network fallback).
// • Same-origin images: stale-while-revalidate.
// • Updates: a new worker waits until the customer taps "Refresh" (the page sends SKIP_WAITING), so pages never mix versions.
const VERSION = "tcs-v5";
const SHELL = [
  "./", "index.html", "shop.html", "product.html", "cart.html", "checkout.html", "login.html", "account.html", "addresses.html",
  "orders.html", "order-details.html", "wishlist.html", "reviews.html",
  "style.css", "home.css", "shop.css", "product.css", "cart-checkout.css", "account.css", "orders.css", "responsive.css",
  "firebase.js", "auth.js", "common.js", "home.js", "shop.js", "product.js", "cart.js", "checkout.js", "account.js", "addresses.js", "orders.js", "wishlist-reviews.js",
  "logo-header.webp", "logo.png", "favicon.png", "product-placeholder.png", "empty-cart.png", "empty-wishlist.png", "hero-fallback.jpg", "manifest.json"
];
const MAX_RUNTIME_ENTRIES = 80;
const IMAGE_RE = /\.(?:png|jpe?g|webp|gif|svg|ico)$/i;

const OFFLINE_PAGE = `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Offline — The Chocolate Story</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF6F0;color:#2D1910;font:17px/1.6 system-ui,sans-serif;text-align:center;padding:1.5rem}main{max-width:30rem}h1{font:600 2rem Georgia,serif;color:#542E1D;margin:0 0 .5rem}a,button{display:inline-block;margin-top:1rem;padding:.7rem 1.6rem;border-radius:999px;background:#542E1D;color:#FBF6F0;border:0;font:inherit;text-decoration:none;cursor:pointer}</style></head>
<body><main><h1>You're offline</h1><p>We can't reach The Chocolate Story right now. Check your connection and try again — your cart is saved on this device.</p><button type="button" onclick="location.reload()">Try again</button></main></body></html>`;
const offlineResponse = () => new Response(OFFLINE_PAGE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" }))))));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("tcs-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => { if (event.data === "SKIP_WAITING") self.skipWaiting(); });

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.filter((r) => !SHELL.some((s) => new URL(r.url).pathname.endsWith("/" + s.replace(/^\.\//, "")) )).slice(0, Math.max(0, keys.length - MAX_RUNTIME_ENTRIES));
  await Promise.all(extra.map((r) => cache.delete(r)));
}
function networkFirst(req, { timeout = 5000, ignoreSearch = false } = {}) {
  return new Promise(async (resolve) => {
    let done = false;
    const cache = await caches.open(VERSION);
    const fallback = async () => (await cache.match(req, { ignoreSearch })) || (req.mode === "navigate" ? ((await cache.match("index.html")) || offlineResponse()) : null);
    const timer = setTimeout(async () => { const hit = await cache.match(req, { ignoreSearch }); if (hit && !done) { done = true; resolve(hit); } }, timeout);
    try {
      const res = await fetch(req);
      clearTimeout(timer);
      if (res.ok && res.type === "basic") { cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {}); }
      if (!done) { done = true; resolve(res); }
    } catch {
      clearTimeout(timer);
      if (!done) { done = true; resolve((await fallback()) || Response.error()); }
    }
  });
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/sw.js")) return;
  if (req.mode === "navigate") return event.respondWith(networkFirst(req, { ignoreSearch: true }));
  if (IMAGE_RE.test(url.pathname)) return event.respondWith(staleWhileRevalidate(req));
  event.respondWith(networkFirst(req));
});
