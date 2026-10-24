// common.js — shared header/footer, menu, toasts, state helpers and small utilities.
import { db, doc, getDoc, auth } from "./firebase.js";
import { onUserChange, signOutUser, isGoogleUser } from "./auth.js";

// Safety net: the DOM turns null/undefined/false children into the literal text "null"/"false". Drop them instead.
for (const m of ["replaceChildren", "append", "prepend"]) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...nodes) { return orig.apply(this, nodes.filter(n => n != null && n !== false)); };
}

export const CART_KEY = "tcs_cart_v1";            // shared with cart.js (Stage 3)
const FALLBACK = {
  siteName: "The Chocolate Story",
  contactEmail: "thechocolatestory.ind@gmail.com",
  whatsappNumber: "+918847050895",
  instagramURL: "https://www.instagram.com/_thechocolatestory_/",
  currency: "INR", currencySymbol: "₹",
  announcementEnabled: false, announcementText: "", maintenanceMode: false
};

/* ---------- small utilities ---------- */
/** Safe element factory: strings become text nodes, never HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function formatINR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** Allow only http(s) URLs (and optionally same-site relative paths). */
export function safeUrl(raw, { allowRelative = false } = {}) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (allowRelative && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("//") && !s.includes("\\")) return s;
  try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") ? u.href : null; }
  catch { return null; }
}

export function whatsappLink(number, message = "") {
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return "https://wa.me/" + digits + (message ? "?text=" + encodeURIComponent(message) : "");
}

/** Instagram profile URL without tracking parameters; only instagram.com hosts allowed. */
export function cleanInstagramUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !/(^|\.)instagram\.com$/.test(u.hostname)) return FALLBACK.instagramURL;
    return u.origin + u.pathname.replace(/\/?$/, "/");
  } catch { return FALLBACK.instagramURL; }
}

/* ---------- public site settings (siteSettings/public) ---------- */
let settingsPromise = null;
export function getPublicSettings() {
  if (!settingsPromise) {
    settingsPromise = getDoc(doc(db, "siteSettings", "public"))
      .then(s => ({ ...FALLBACK, ...(s.exists() ? s.data() : {}), _live: s.exists() }))
      .catch(() => ({ ...FALLBACK, _live: false }));
  }
  return settingsPromise;
}

/* ---------- toast / loading / empty / error ---------- */
let toastHost;
export function showToast(message, { type = "info", timeout = 4500, action } = {}) {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host", role: "region", "aria-label": "Notifications", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = el("div", { class: "toast toast--" + type, role: type === "error" ? "alert" : "status" },
    el("span", { text: message }),
    action ? el("button", { type: "button", class: "toast__action", onclick: () => { t.remove(); action.onClick(); } }, action.label) : null,
    el("button", { type: "button", class: "toast__close", "aria-label": "Dismiss notification", onclick: () => t.remove() }, "×"));
  toastHost.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}
export function renderLoading(container, label = "Loading…") {
  container.replaceChildren(el("div", { class: "state state--loading", role: "status" },
    el("span", { class: "spinner", "aria-hidden": "true" }), el("p", { text: label })));
}
export function renderEmpty(container, { title, text, image, actionText, actionHref } = {}) {
  container.replaceChildren(el("div", { class: "state state--empty" },
    image ? el("img", { src: image, alt: "", width: 160, height: 160, loading: "lazy" }) : null,
    el("h2", { class: "state__title", text: title || "Nothing here yet" }),
    text ? el("p", { text }) : null,
    actionHref ? el("a", { class: "btn btn--primary", href: actionHref, text: actionText || "Continue" }) : null));
}
export function renderError(container, message, onRetry) {
  container.replaceChildren(el("div", { class: "state state--error", role: "alert" },
    el("h2", { class: "state__title", text: "Something went wrong" }),
    el("p", { text: message || "We couldn't load this right now. Please check your connection and try again." }),
    onRetry ? el("button", { type: "button", class: "btn btn--primary", onclick: onRetry }, "Try again") : null));
}


/* ---------- shared product helpers (Stage 3) ---------- */
export const num = (v, d = 0) => (v !== null && v !== "" && Number.isFinite(Number(v))) ? Number(v) : d;
export const MAX_QTY = 20;

/** Can this product be offered for purchase right now (UI hint only — the backend decides finally)? */
export function purchasable(p) {
  if (!p || p.isActive !== true || p.isAvailable === false) return false;
  if (p.trackInventory === true && Number.isFinite(Number(p.stockQuantity)) && Number(p.stockQuantity) <= 0 && p.allowBackorder !== true) return false;
  return true;
}
/** Largest quantity the UI will let a customer pick. */
export function maxQuantity(p) {
  if (p && p.trackInventory === true && p.allowBackorder !== true && Number.isFinite(Number(p.stockQuantity))) return Math.max(0, Math.min(MAX_QTY, Math.floor(Number(p.stockQuantity))));
  return MAX_QTY;
}
/** All usable images: primaryImage first, then `images` by sortOrder, de-duplicated. */
export function productImages(p) {
  const out = [], seen = new Set();
  const push = (url, alt) => { const u = safeUrl(url); if (u && !seen.has(u)) { seen.add(u); out.push({ url: u, alt: alt || (p && p.name) || "" }); } };
  // `images` may hold plain URL strings (what the admin panel stores) and/or objects like { url, alt, sortOrder }.
  const list = Array.isArray(p && p.images)
    ? p.images.map((x, i) => typeof x === "string" ? { url: x, alt: "", sortOrder: i } : (x && typeof x === "object" ? { ...x, sortOrder: num(x.sortOrder, i) } : null)).filter(Boolean).sort((a, b) => a.sortOrder - b.sortOrder)
    : [];
  const primary = p && p.primaryImage;
  const match = list.find(x => x.url === primary);
  push(primary, match && match.alt);
  list.forEach(x => push(x.url, x.alt));
  return out;
}
export function priceText(p) {
  return Number.isFinite(Number(p && p.basePrice)) ? (p.productType === "customizable" ? "From " : "") + formatINR(p.basePrice) : "";
}
/** Product card used by shop and wishlist. `onWish(product, button)` adds a wishlist heart. */
export function productCard(p, { saved = false, onWish } = {}) {
  const first = productImages(p)[0];
  const ok = purchasable(p), price = priceText(p);
  const media = el("span", { class: "pcard__media" },
    el("img", { src: first ? first.url : "product-placeholder.png", alt: first ? first.alt : "", width: 600, height: 600, loading: "lazy", decoding: "async", onerror: function () { if (!this.src.endsWith("product-placeholder.png")) this.src = "product-placeholder.png"; } }),
    ok ? null : el("span", { class: "pcard__badge", text: "Currently unavailable" }));
  const link = el("a", { class: "pcard", href: "product.html?id=" + encodeURIComponent(p.id) }, media,
    el("span", { class: "pcard__body" },
      el("span", { class: "pcard__name", text: p.name || "Product" }),
      p.shortDescription ? el("span", { class: "pcard__desc", text: p.shortDescription }) : null,
      price ? el("span", { class: "pcard__price", text: price }) : null));
  const li = el("li", { class: "pcard-wrap" }, link);
  if (onWish) {
    const btn = el("button", { type: "button", class: "wish", "aria-pressed": String(saved), "aria-label": "Save " + (p.name || "product") + " to wishlist" }, icon(ICONS.heart));
    btn.addEventListener("click", () => onWish(p, btn));
    li.append(btn);
  }
  return li;
}
export function setWishState(btn, saved) { btn.setAttribute("aria-pressed", String(saved)); btn.setAttribute("aria-label", (saved ? "Remove " : "Save ") + (btn.getAttribute("aria-label").replace(/^(Save|Remove) /, "").replace(/ (to|from) wishlist$/, "")) + (saved ? " from wishlist" : " to wishlist")); }
export function setMeta(title, description) {
  if (title) { document.title = title; const t = document.querySelector('meta[property="og:title"]'); if (t) t.setAttribute("content", title); }
  if (description) { const d = document.querySelector('meta[name="description"]'), o = document.querySelector('meta[property="og:description"]'); if (d) d.setAttribute("content", description); if (o) o.setAttribute("content", description); }
}


/* ---------- trusted-backend adapter (Stage 4) ---------- */
// The browser may NOT create orders, record payments, cancel orders or submit reviews (see firestore.rules).
// Those actions call a trusted HTTPS backend you operate. Until `baseUrl` is set, every protected action stays disabled.
// Contracts for each endpoint are documented in README.md. NEVER put a Razorpay secret or any private key in this file.
export const BACKEND_CONFIG = {
  baseUrl: "", // e.g. "https://api.example.com" (HTTPS only, no trailing slash). Empty = protected actions disabled.
  endpoints: { createOrder: "/checkout/create-order", verifyPayment: "/checkout/verify-payment", cancelOrder: "/orders/cancel", submitReview: "/reviews/submit" }
};
export const backendConfigured = () => typeof BACKEND_CONFIG.baseUrl === "string" && /^https:\/\/[^\s/]+[^\s]*$/i.test(BACKEND_CONFIG.baseUrl) && !BACKEND_CONFIG.baseUrl.endsWith("/");
export class BackendError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
/** POSTs JSON with the customer's Firebase ID token. Resolves with parsed JSON or throws BackendError (friendly message). */
export async function callBackend(endpointKey, payload) {
  if (!backendConfigured()) throw new BackendError("This service isn't switched on yet.", 0, "not-configured");
  const user = auth.currentUser;
  if (!user) throw new BackendError("Please sign in again.", 401, "unauthenticated");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const token = await user.getIdToken();
    const res = await fetch(BACKEND_CONFIG.baseUrl + BACKEND_CONFIG.endpoints[endpointKey], {
      method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(payload)
    });
    let data = null; try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const msg = data && data.error && typeof data.error.message === "string" ? data.error.message.slice(0, 220) : (res.status === 401 || res.status === 403 ? "Please sign in again and retry." : "The request couldn't be completed. Please try again.");
      throw new BackendError(msg, res.status, data && data.error && data.error.code);
    }
    return data || {};
  } catch (err) {
    if (err instanceof BackendError) throw err;
    throw new BackendError(err && err.name === "AbortError" ? "The request took too long. Please check your connection and try again." : "We couldn't reach the server. Please check your connection and try again.", 0, "network");
  } finally { clearTimeout(timer); }
}
export function toDate(v) {
  if (!v) return null;
  const d = typeof v.toDate === "function" ? v.toDate() : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function formatDate(v, withTime = false) {
  const d = toDate(v); if (!d) return "";
  return d.toLocaleString("en-IN", withTime ? { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}
export function renderInactive(container) {
  container.replaceChildren(el("div", { class: "state state--error", role: "alert" }, el("h2", { class: "state__title", text: "Your account is inactive" }),
    el("p", { text: "Please contact The Chocolate Story on WhatsApp or Instagram and we'll help." }), el("a", { class: "btn btn--primary", href: "index.html", text: "Back to home" })));
}


/* ---------- cart badge (reads only a count; never prices) ---------- */
export function getCartCount() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "null");
    const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
    return items.reduce((n, i) => n + (Number.isInteger(i && i.quantity) && i.quantity > 0 ? Math.min(i.quantity, 99) : 0), 0);
  } catch { return 0; }
}
export function updateCartBadge() {
  const n = getCartCount();
  $$("[data-cart-count]").forEach(b => { b.textContent = n > 99 ? "99+" : String(n); b.hidden = n === 0; });
  $$("[data-cart-link]").forEach(a => a.setAttribute("aria-label", n ? `Cart, ${n} item${n === 1 ? "" : "s"}` : "Cart"));
}

/* ---------- header / footer ---------- */
const NAV = [
  { href: "index.html", text: "Home", page: "home" },
  { href: "shop.html", text: "Shop", page: "shop" },
  { href: "reviews.html", text: "Reviews", page: "reviews" },
  { href: "wishlist.html", text: "Wishlist", page: "wishlist" }
];
const icon = (path) => {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "22"); s.setAttribute("height", "22");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.7");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path"); p.setAttribute("d", path); s.append(p); return s;
};
const ICONS = {
  user: "M20 21a8 8 0 0 0-16 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  heart: "M12 21s-7-4.4-9-9.2C1.6 8.4 3.6 5 7 5c2 0 3.7 1.1 5 3 1.3-1.9 3-3 5-3 3.4 0 5.4 3.4 4 6.8C19 16.6 12 21 12 21z",
  bag: "M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 0 1 6 0v2",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18"
};

function buildHeader(page) {
  const navLinks = (cls) => NAV.map(n => el("a", { class: cls, href: n.href, "aria-current": n.page === page ? "page" : false, text: n.text }));
  const accountLink = el("a", { class: "icon-btn", href: "login.html", "data-account-link": "", "aria-label": "Sign in" }, icon(ICONS.user));
  const header = el("header", { class: "site-header" },
    el("div", { class: "container site-header__bar" },
      el("button", { type: "button", class: "icon-btn menu-toggle", "aria-label": "Open menu", "aria-expanded": "false", "aria-controls": "mobile-drawer" }, icon(ICONS.menu)),
      el("a", { class: "brand", href: "index.html", "aria-label": "The Chocolate Story — home" },
        el("img", { src: "logo-header.webp", alt: "The Chocolate Story", width: 1380, height: 719 })),
      el("nav", { class: "site-nav", "aria-label": "Main" }, navLinks("site-nav__link")),
      el("div", { class: "site-header__actions" },
        accountLink,
        el("a", { class: "icon-btn icon-btn--wish", href: "wishlist.html", "aria-label": "Wishlist" }, icon(ICONS.heart)),
        el("a", { class: "icon-btn", href: "cart.html", "data-cart-link": "", "aria-label": "Cart" }, icon(ICONS.bag),
          el("span", { class: "badge", "data-cart-count": "", hidden: true }, "0")))));
  const drawer = el("div", { class: "drawer", id: "mobile-drawer", hidden: true },
    el("div", { class: "drawer__scrim", "data-drawer-close": "" }),
    el("div", { class: "drawer__panel", role: "dialog", "aria-modal": "true", "aria-label": "Site menu" },
      el("div", { class: "drawer__head" },
        el("img", { src: "logo-header.webp", alt: "The Chocolate Story", width: 1380, height: 719 }),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Close menu", "data-drawer-close": "" }, icon(ICONS.close))),
      el("nav", { class: "drawer__nav", "aria-label": "Mobile" },
        navLinks("drawer__link"),
        el("a", { class: "drawer__link", href: "cart.html", text: "Cart" }),
        el("a", { class: "drawer__link", href: "orders.html", text: "My orders" }),
        el("a", { class: "drawer__link", href: "addresses.html", text: "Saved addresses" }),
        el("a", { class: "drawer__link", href: "account.html", "data-account-text": "", text: "Sign in" })),
      el("button", { type: "button", class: "btn btn--ghost drawer__signout", "data-signout": "", hidden: true }, "Sign out")));
  return [el("a", { class: "skip-link", href: "#main", text: "Skip to main content" }), el("div", { id: "announce-slot" }), header, drawer];
}

function setupDrawer() {
  const drawer = $("#mobile-drawer"), toggle = $(".menu-toggle");
  if (!drawer || !toggle) return;
  let lastFocus = null;
  const focusables = () => $$("a[href], button:not([hidden])", drawer.querySelector(".drawer__panel"));
  const close = () => { drawer.hidden = true; document.body.classList.remove("no-scroll"); toggle.setAttribute("aria-expanded", "false"); (lastFocus || toggle).focus(); };
  const open = () => { lastFocus = document.activeElement; drawer.hidden = false; document.body.classList.add("no-scroll"); toggle.setAttribute("aria-expanded", "true"); focusables()[0]?.focus(); };
  toggle.addEventListener("click", open);
  $$("[data-drawer-close]", drawer).forEach(b => b.addEventListener("click", close));
  drawer.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  drawer.addEventListener("click", e => { if (e.target.closest("a")) { drawer.hidden = true; document.body.classList.remove("no-scroll"); } });
}

function applyAuthState(user) {
  const signedIn = isGoogleUser(user);
  $$("[data-account-link]").forEach(a => { a.href = signedIn ? "account.html" : "login.html"; a.setAttribute("aria-label", signedIn ? "My account" : "Sign in"); });
  $$("[data-account-text]").forEach(a => { a.textContent = signedIn ? "My account" : "Sign in"; a.href = signedIn ? "account.html" : "login.html"; });
  $$("[data-signout]").forEach(b => { b.hidden = !signedIn; });
}

function applySettings(s) {
  const slot = $("#announce-slot");
  if (slot) {
    const msgs = [];
    if (s.maintenanceMode) msgs.push("We're carrying out maintenance, so some features may be limited. You can still reach us on WhatsApp or Instagram.");
    else if (s.announcementEnabled && String(s.announcementText || "").trim()) msgs.push(String(s.announcementText).trim());
    slot.replaceChildren(...msgs.map(m => el("div", { class: "announce", role: "status" }, el("p", { class: "container", text: m }))));
  }
  const wa = whatsappLink(s.whatsappNumber, "Hello The Chocolate Story! I have a question.");
  const ig = cleanInstagramUrl(s.instagramURL);
  const contact = $("#footer-contact");
  if (contact) {
    contact.replaceChildren(
      s.contactEmail ? el("li", {}, el("a", { href: "mailto:" + s.contactEmail, text: s.contactEmail })) : null,
      wa ? el("li", {}, el("a", { href: wa, target: "_blank", rel: "noopener noreferrer", text: "WhatsApp: " + s.whatsappNumber })) : null,
      el("li", {}, el("a", { href: ig, target: "_blank", rel: "noopener noreferrer", text: "Instagram: @_thechocolatestory_" })));
  }
}

function buildFooter() {
  return el("footer", { class: "site-footer" },
    el("div", { class: "container site-footer__grid" },
      el("div", { class: "site-footer__brand" },
        el("img", { src: "logo-header.webp", alt: "The Chocolate Story", width: 1380, height: 719, loading: "lazy" }),
        el("p", { text: "Premium chocolates, cakes, desserts, gifts and hampers — 100% eggless, delivered across India." })),
      el("nav", { "aria-label": "Shop links" }, el("h2", { class: "footer-h", text: "Explore" }),
        el("ul", {}, [["shop.html", "Shop"], ["wishlist.html", "Wishlist"], ["cart.html", "Cart"], ["reviews.html", "Reviews"]].map(([h, t]) => el("li", {}, el("a", { href: h, text: t }))), el("li", {}, el("button", { type: "button", class: "link-btn link-btn--light", "data-install": "", hidden: true }, "Install app")))),
      el("nav", { "aria-label": "Account links" }, el("h2", { class: "footer-h", text: "Your account" }),
        el("ul", {}, [["login.html", "Sign in"], ["orders.html", "My orders"], ["addresses.html", "Saved addresses"], ["account.html", "Profile"]].map(([h, t]) => el("li", {}, el("a", { href: h, text: t }))))),
      el("nav", { class: "site-footer__info", "aria-label": "Information and policies" }, el("h2", { class: "footer-h", text: "Information" }),
        el("ul", {}, [["about.html", "About Us"], ["privacy-policy.html", "Privacy Policy"], ["terms-and-conditions.html", "Terms & Conditions"], ["shipping-policy.html", "Shipping Policy"], ["cancellation-policy.html", "Cancellation Policy"], ["return-refund-policy.html", "Return & Refund Policy"], ["contact.html", "Contact Us"], ["shop.html", "Products & Pricing"]].map(([h, t]) => el("li", {}, el("a", { href: h, text: t }))))),
      el("div", { class: "site-footer__contact" }, el("h2", { class: "footer-h", text: "Contact" }), el("ul", { id: "footer-contact" }))),
    el("div", { class: "container site-footer__legal" },
      el("p", { text: "Online payment only — no Cash on Delivery. Delivery usually takes around 6–8 days from the order date; this is an estimate, not a guarantee." }),
      el("p", { text: "© " + new Date().getFullYear() + " The Chocolate Story" })));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const ok = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!ok) return;
  let refreshRequested = false, reloading = false;
  // Reload ONLY after the customer taps "Refresh" — never on first install or silently (they may be mid-form).
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (refreshRequested && !reloading) { reloading = true; location.reload(); } });
  const offerUpdate = (worker) => showToast("A new version of the shop is ready.", { timeout: 0, action: { label: "Refresh", onClick: () => { refreshRequested = true; worker.postMessage("SKIP_WAITING"); } } });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).then(reg => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offerUpdate(w); });
      });
    }).catch(() => { /* the shop works without a service worker */ });
  });
}

/* Install prompt (Chromium/Android). iOS has no such event — see README for "Add to Home Screen". */
let installEvent = null;
function setupInstall() {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; $$("[data-install]").forEach(b => { b.hidden = false; }); });
  window.addEventListener("appinstalled", () => { installEvent = null; $$("[data-install]").forEach(b => { b.hidden = true; }); showToast("The Chocolate Story is installed.", { type: "success" }); });
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-install]") || !installEvent) return;
    installEvent.prompt(); try { await installEvent.userChoice; } catch { /* ignore */ } installEvent = null; $$("[data-install]").forEach(b => { b.hidden = true; });
  });
}
function setupConnectivity() {
  window.addEventListener("offline", () => showToast("You're offline. Browsing may be limited until you reconnect.", { type: "error", timeout: 6000 }));
  window.addEventListener("online", () => showToast("You're back online.", { type: "success", timeout: 3000 }));
}

function initChrome() {
  const page = document.body.dataset.page || "";
  const headerHost = $("#site-header"), footerHost = $("#site-footer");
  if (headerHost) { headerHost.replaceChildren(...buildHeader(page)); setupDrawer(); }
  if (footerHost) { footerHost.replaceChildren(buildFooter()); }
  updateCartBadge();
  window.addEventListener("storage", e => { if (e.key === CART_KEY) updateCartBadge(); });
  window.addEventListener("tcs:cart-changed", updateCartBadge);
  onUserChange(applyAuthState);
  document.addEventListener("click", async e => {
    if (!e.target.closest("[data-signout]")) return;
    try { await signOutUser(); showToast("You've been signed out.", { type: "success" }); location.href = "index.html"; }
    catch { showToast("Couldn't sign out. Please try again.", { type: "error" }); }
  });
  getPublicSettings().then(applySettings);
  registerServiceWorker(); setupInstall(); setupConnectivity();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initChrome); else initChrome();
