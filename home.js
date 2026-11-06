// home.js — live homepage: banners, highlights, categories, featured/new products, reviews, custom-order menu.
// All queries are single-field `where(...)` so they work with the current rules and need no composite indexes;
// ordering is done client-side. Database strings are only ever inserted as text.
import { db, collection, getDocs, query, where, limit } from "./firebase.js";
import { $, el, formatINR, safeUrl, whatsappLink, cleanInstagramUrl, getPublicSettings, renderError } from "./common.js";

const PAGES = ["index", "shop", "product", "cart", "checkout", "login", "account", "addresses", "orders", "order-details", "wishlist", "reviews"];
const ALIASES = { "": "index.html", home: "index.html", products: "shop.html", product: "shop.html", shop: "shop.html", catalogue: "shop.html" };
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- helpers ---------- */
/** Resolve an admin-entered link: https(s) URLs, or a known storefront page (tolerates "/products"). Otherwise null. */
function resolveLink(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const abs = safeUrl(raw);
  if (abs) return abs;
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//") || s.includes("\\")) return null;
  const clean = s.replace(/^\.?\//, "");
  const [path, rest = ""] = clean.split(/(?=[?#])/);
  const name = path.replace(/\.html$/, "");
  if (name in ALIASES) return ALIASES[name] + rest;
  return PAGES.includes(name) ? name + ".html" + rest : null;
}
const external = (href) => /^https?:/i.test(href);
const linkAttrs = (href) => external(href) ? { href, target: "_blank", rel: "noopener noreferrer" } : { href };
const millis = (v) => (v && typeof v.toMillis === "function") ? v.toMillis() : 0;
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
async function fetchActive(name, extra = []) {
  const snap = await getDocs(query(collection(db, name), where("isActive", "==", true), ...extra));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
const bySort = (a, b) => num(a.sortOrder, 9999) - num(b.sortOrder, 9999);

function img(url, alt, { w, h, eager = false, fallback, cls } = {}) {
  const src = safeUrl(url);
  const node = el("img", { src: src || fallback, alt: alt || "", width: w, height: h, class: cls, loading: eager ? "eager" : "lazy", decoding: "async" });
  if (fallback) node.addEventListener("error", () => { if (!node.src.endsWith(fallback)) node.src = fallback; }, { once: true });
  return node;
}
function skeleton(n, cls) { return el("div", { class: "skeleton-row " + (cls || ""), "aria-hidden": "true" }, Array.from({ length: n }, () => el("div", { class: "skeleton" }))); }

/** Runs a section: skeleton → render, or remove when empty, or retry-able error. */
async function runSection(id, slotId, loader, render, skeletonN = 4) {
  const sec = document.getElementById(id), slot = document.getElementById(slotId);
  if (!sec || !slot) return;
  const go = async () => {
    sec.setAttribute("aria-busy", "true");
    slot.replaceChildren(skeleton(skeletonN, id === "sec-highlights" ? "hl-skel" : ""));
    try {
      const data = await loader();
      const node = data && render(data);
      if (!node) { sec.remove(); return; }
      slot.replaceChildren(node); reveal(sec);
    } catch (err) {
      renderError(slot, "We couldn't load this section. Please check your connection and try again.", go);
    } finally { sec.removeAttribute("aria-busy"); }
  };
  await go();
}


/* ---------- scroll reveal (fade/slide in as sections come into view; skipped for reduced motion) ---------- */
const REVEAL = ".sec-head, .trust li, .hl-row li, .cat-grid li, .p-grid li, .rev, .occasions li, .story__grid > *, .story__points li, .reassure__grid > *";
let revealIO = null;
function reveal(root = document) {
  if (reduceMotion() || !("IntersectionObserver" in window)) return;
  revealIO = revealIO || new IntersectionObserver((entries) => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("is-in"); revealIO.unobserve(e.target); } }), { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
  const seen = new Map();
  root.querySelectorAll(REVEAL).forEach(n => {
    if (n.classList.contains("js-reveal")) return;
    const k = n.parentElement, i = seen.get(k) || 0; seen.set(k, i + 1);
    n.style.setProperty("--d", Math.min(i, 6) * 70 + "ms");
    n.classList.add("js-reveal"); revealIO.observe(n);
  });
}

/* ---------- hero carousel ---------- */
function buildHero(banners) {
  let index = 0, timer = null, userPaused = reduceMotion(), hovering = false;
  const slides = banners.map((b, i) => {
    const href = resolveLink(b.buttonLink);
    const desktop = safeUrl(b.imageURL), mobile = safeUrl(b.mobileImageURL);
    const media = el("div", { class: "hero__media" });
    if (desktop || mobile) {
      const pic = el("picture", {}, mobile ? el("source", { media: "(max-width: 700px)", srcset: mobile }) : null,
        el("img", { src: desktop || mobile, alt: "", width: 1600, height: 800, loading: i === 0 ? "eager" : "lazy", decoding: "async", fetchpriority: i === 0 ? "high" : "auto" }));
      media.append(pic);
    }
    const text = el("div", { class: "container hero__copy" },
      i === 0 ? el("h1", { class: "hero__title", text: b.title || "The Chocolate Story" }) : el("p", { class: "hero__title", text: b.title || "" }),
      b.subtitle ? el("p", { class: "hero__sub", text: b.subtitle }) : null,
      href && b.buttonText ? el("a", { class: "btn btn--caramel", ...linkAttrs(href), text: b.buttonText }) : null);
    return el("div", { class: "hero__slide", role: "group", "aria-roledescription": "slide", "aria-label": `${i + 1} of ${banners.length}` }, media, el("div", { class: "hero__shade" }), text);
  });
  const dots = banners.map((_, i) => el("button", { type: "button", class: "hero__dot", "aria-label": `Show slide ${i + 1}`, onclick: () => show(i, true) }));
  const live = el("div", { class: "hero__viewport", "aria-live": "off" }, ...slides);
  const pauseBtn = el("button", { type: "button", class: "hero__ctl hero__pause", onclick: () => { userPaused = !userPaused; sync(); } });
  const multi = banners.length > 1;
  const root = el("section", { class: "hero", "aria-roledescription": "carousel", "aria-label": "Featured offers" }, live,
    multi ? el("div", { class: "hero__bar" },
      el("div", { class: "hero__dots" }, dots),
      el("div", { class: "hero__ctls" },
        el("button", { type: "button", class: "hero__ctl", "aria-label": "Previous slide", onclick: () => show(index - 1, true) }, "‹"),
        pauseBtn,
        el("button", { type: "button", class: "hero__ctl", "aria-label": "Next slide", onclick: () => show(index + 1, true) }, "›"))) : null);

  function show(i, manual) {
    index = (i + slides.length) % slides.length;
    slides.forEach((s, k) => { const on = k === index; s.classList.toggle("is-active", on); s.setAttribute("aria-hidden", on ? "false" : "true"); if (on) s.removeAttribute("inert"); else s.setAttribute("inert", ""); });
    dots.forEach((d, k) => { if (k === index) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current"); });
    if (manual) restart();
  }
  function sync() {
    pauseBtn.textContent = userPaused ? "Play" : "Pause";
    pauseBtn.setAttribute("aria-label", userPaused ? "Start automatic slide show" : "Pause automatic slide show");
    live.setAttribute("aria-live", userPaused ? "polite" : "off");
    restart();
  }
  function restart() {
    clearInterval(timer);
    if (multi && !userPaused && !hovering && !document.hidden) timer = setInterval(() => show(index + 1), 6500);
  }
  if (multi) {
    root.addEventListener("mouseenter", () => { hovering = true; restart(); });
    root.addEventListener("mouseleave", () => { hovering = false; restart(); });
    root.addEventListener("focusin", () => { hovering = true; restart(); });
    root.addEventListener("focusout", () => { hovering = false; restart(); });
    document.addEventListener("visibilitychange", restart);
    let x0 = null;
    live.addEventListener("pointerdown", e => { x0 = e.clientX; });
    live.addEventListener("pointerup", e => { if (x0 != null && Math.abs(e.clientX - x0) > 50) show(index + (e.clientX < x0 ? 1 : -1), true); x0 = null; });
    root.addEventListener("keydown", e => { if (e.key === "ArrowRight") show(index + 1, true); else if (e.key === "ArrowLeft") show(index - 1, true); });
  }
  show(0); if (multi) sync();
  return root;
}

/* ---------- highlights (circles + story viewer) ---------- */
let viewerCleanup = null;
function openViewer(group, opener) {
  const items = group.items; let i = 0;
  const prev = document.activeElement;
  const title = el("p", { class: "viewer__title", id: "viewer-title", text: group.title || "Highlight" });
  const bars = el("div", { class: "viewer__bars", "aria-hidden": "true" }, items.map(() => el("span", {})));
  const stage = el("div", { class: "viewer__stage" });
  const caption = el("p", { class: "viewer__caption", "aria-live": "polite" });
  const linkSlot = el("div", { class: "viewer__link" });
  const count = el("span", { class: "visually-hidden", "aria-live": "polite" });
  const closeBtn = el("button", { type: "button", class: "viewer__close", "aria-label": "Close highlight", onclick: close }, "×");
  const prevBtn = el("button", { type: "button", class: "viewer__nav viewer__nav--prev", "aria-label": "Previous slide", onclick: () => go(i - 1) }, "‹");
  const nextBtn = el("button", { type: "button", class: "viewer__nav viewer__nav--next", "aria-label": "Next slide", onclick: () => go(i + 1) }, "›");
  const dialog = el("div", { class: "viewer__panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "viewer-title" },
    bars, el("div", { class: "viewer__head" }, title, closeBtn), stage, prevBtn, nextBtn, el("div", { class: "viewer__foot" }, caption, linkSlot), count);
  const scrim = el("div", { class: "viewer", onclick: e => { if (e.target === scrim) close(); } }, dialog);

  function go(n) {
    i = Math.min(Math.max(n, 0), items.length - 1);
    const it = items[i];
    stage.replaceChildren(img(it.imageURL, it.caption || "", { w: 900, h: 1200, eager: true, cls: "viewer__img", fallback: "product-placeholder.png" }));
    caption.textContent = it.caption || "";
    const href = resolveLink(it.linkURL);
    linkSlot.replaceChildren(...(href ? [el("a", { class: "btn btn--caramel", ...linkAttrs(href), text: "Learn more" })] : []));
    [...bars.children].forEach((b, k) => b.classList.toggle("is-done", k <= i));
    prevBtn.hidden = i === 0; nextBtn.hidden = i === items.length - 1;
    count.textContent = `Slide ${i + 1} of ${items.length}`;
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Tab") {
      const f = [...dialog.querySelectorAll("a[href],button")].filter(n => !n.hidden);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    scrim.remove(); document.body.classList.remove("no-scroll"); viewerCleanup = null;
    (opener || prev)?.focus?.();
  }
  if (viewerCleanup) viewerCleanup();
  viewerCleanup = close;
  document.addEventListener("keydown", onKey);
  document.body.append(scrim); document.body.classList.add("no-scroll");
  go(0); closeBtn.focus();
}
function renderHighlights(groups) {
  const list = groups.map(g => {
    const cover = g.coverImageURL || g.items[0].imageURL;
    const btn = el("button", { type: "button", class: "hl", "aria-haspopup": "dialog" },
      el("span", { class: "hl__ring" }, safeUrl(cover) ? img(cover, "", { w: 84, h: 84, fallback: "product-placeholder.png", cls: "hl__img" }) : el("span", { class: "hl__initial", text: (g.title || "•").slice(0, 1) })),
      el("span", { class: "hl__label", text: g.title || "Highlight" }));
    btn.addEventListener("click", () => openViewer(g, btn));
    return el("li", {}, btn);
  });
  return el("ul", { class: "hl-row", "aria-label": "Highlights" }, list);
}

/* ---------- categories & products ---------- */
function renderCategories(cats) {
  return el("ul", { class: "cat-grid" }, cats.map(c => el("li", {},
    el("a", { class: "cat", href: "shop.html?category=" + encodeURIComponent(c.id) },
      safeUrl(c.imageURL) ? img(c.imageURL, "", { w: 600, h: 600, fallback: "product-placeholder.png", cls: "cat__img" }) : el("span", { class: "cat__fallback", "aria-hidden": "true" }),
      el("span", { class: "cat__name" }, el("strong", { text: c.name || "Category" }), c.description ? el("small", { text: c.description }) : null)))));
}
function purchasable(p) {
  if (p.isAvailable === false) return false;
  if (p.trackInventory === true && Number.isFinite(Number(p.stockQuantity)) && Number(p.stockQuantity) <= 0 && p.allowBackorder !== true) return false;
  return true;
}
function productImage(p) {
  const imgs = Array.isArray(p.images) ? p.images.filter(x => x && safeUrl(x.url)).sort(bySort) : [];
  return { url: safeUrl(p.primaryImage) || (imgs[0] && imgs[0].url) || "", alt: (imgs[0] && imgs[0].alt) || p.name || "" };
}
function productCard(p) {
  const pi = productImage(p);
  const price = Number.isFinite(Number(p.basePrice)) ? (p.productType === "customizable" ? "From " : "") + formatINR(p.basePrice) : "";
  return el("li", {}, el("a", { class: "pcard", href: "product.html?id=" + encodeURIComponent(p.id) },
    el("span", { class: "pcard__media" }, img(pi.url, pi.alt, { w: 600, h: 600, fallback: "product-placeholder.png" })),
    el("span", { class: "pcard__body" },
      el("span", { class: "pcard__name", text: p.name || "Product" }),
      p.shortDescription ? el("span", { class: "pcard__desc", text: p.shortDescription }) : null,
      price ? el("span", { class: "pcard__price", text: price }) : null)));
}
const renderProducts = (list) => list.length ? el("ul", { class: "p-grid" }, list.map(productCard)) : null;

/* ---------- reviews ---------- */
function renderReviews(list) {
  return el("ul", { class: "rev-row" }, list.map(r => {
    const rating = Math.min(5, Math.max(0, Math.round(num(r.rating))));
    return el("li", { class: "rev" },
      el("p", { class: "rev__stars", role: "img", "aria-label": `Rated ${rating} out of 5` }, "★".repeat(rating) + "☆".repeat(5 - rating)),
      el("blockquote", { class: "rev__text" }, el("p", { text: String(r.reviewText).slice(0, 280) + (String(r.reviewText).length > 280 ? "…" : "") })),
      r.isVerifiedPurchase === true ? el("p", { class: "rev__meta", text: "Verified purchase" }) : null);
  }));
}

/* ---------- occasions (static editorial copy — not database content) ---------- */
const OCCASIONS = [
  { name: "Birthdays", line: "Cakes and chocolate boxes that make the day feel personal." },
  { name: "Anniversaries", line: "A sweet way to say another year, another chapter." },
  { name: "Festivals", line: "Hampers made for sharing across the whole family." },
  { name: "Thank-yous", line: "Small, thoughtful gifts that say it better than words." }
];
function initOccasions(settings) {
  const slot = $("#occasions-slot"); if (!slot) return;
  slot.replaceChildren(...OCCASIONS.map(o => {
    const href = whatsappLink(settings.whatsappNumber, `Hello The Chocolate Story! I'd like gifting ideas for ${o.name.toLowerCase()}.`);
    return el("li", {}, href
      ? el("a", { class: "occ", href, target: "_blank", rel: "noopener noreferrer" }, el("strong", { text: o.name }), el("span", { text: o.line }), el("em", { text: "Ask us on WhatsApp" }))
      : el("div", { class: "occ" }, el("strong", { text: o.name }), el("span", { text: o.line })));
  }));
}

/* ---------- floating custom-order menu ---------- */
// If the owner supplies float.png, set this to "float.png"; until then a clean text/CSS button is used.
const FLOAT_IMAGE_FILE = "";
function initCustomOrder(settings) {
  const wa = whatsappLink(settings.whatsappNumber, "Hello The Chocolate Story! I'd like to place a custom order. Here's what I have in mind: ");
  const ig = cleanInstagramUrl(settings.instagramURL);
  const fab = el("button", { type: "button", class: "fab", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "custom-menu" },
    FLOAT_IMAGE_FILE ? el("img", { src: FLOAT_IMAGE_FILE, alt: "", width: 56, height: 56 }) : el("span", { class: "fab__icon", "aria-hidden": "true" }, "♥"),
    el("span", { class: "fab__text", text: "Custom order" }));
  const closeBtn = el("button", { type: "button", class: "menu__close", "aria-label": "Close custom order menu" }, "×");
  const menu = el("div", { class: "cmenu", id: "custom-menu", role: "dialog", "aria-label": "Custom order", hidden: true },
    closeBtn,
    el("h2", { class: "cmenu__title", text: "Design something made for you" }),
    el("p", { text: "Tell us what you have in mind — flavours, occasion, date — and we'll take it from there." }),
    wa ? el("a", { class: "btn btn--primary", href: wa, target: "_blank", rel: "noopener noreferrer", text: "Chat on WhatsApp" }) : null,
    el("a", { class: "btn btn--ghost", href: ig, target: "_blank", rel: "noopener noreferrer", text: "Message on Instagram" }),
    el("p", { class: "cmenu__note", text: "On Instagram, open our profile and send us a message." }));
  const open = () => { menu.hidden = false; fab.setAttribute("aria-expanded", "true"); closeBtn.focus(); };
  const close = (refocus = true) => { menu.hidden = true; fab.setAttribute("aria-expanded", "false"); if (refocus) fab.focus(); };
  fab.addEventListener("click", () => menu.hidden ? open() : close());
  closeBtn.addEventListener("click", () => close());
  menu.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); } });
  document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target) && !fab.contains(e.target)) close(false); });
  document.body.append(el("div", { class: "fab-wrap" }, menu, fab));
}

/* ---------- boot ---------- */
async function boot() {
  const settings = await getPublicSettings();
  initOccasions(settings);
  initCustomOrder(settings);
  reveal();

  // products are shared by two sections: fetch once
  let productsPromise = null;
  const products = () => productsPromise || (productsPromise = fetchActive("products", [limit(120)]).then(l => l.filter(purchasable)));
  const productsFresh = () => { productsPromise = null; return products(); };

  // banners: replace the static intro only when there is live data
  (async () => {
    try {
      const banners = (await fetchActive("banners")).sort(bySort).filter(b => b.title || safeUrl(b.imageURL) || safeUrl(b.mobileImageURL));
      if (banners.length) $("#hero-slot").replaceChildren(buildHero(banners));
    } catch { /* keep the intentional fallback intro */ }
  })();

  await Promise.allSettled([
    runSection("sec-highlights", "highlights-slot", async () => {
      const [hl, items] = await Promise.all([fetchActive("highlights"), fetchActive("highlightItems")]);
      return hl.sort(bySort).map(h => ({ ...h, items: items.filter(i => i.highlightId === h.id && safeUrl(i.imageURL)).sort(bySort) })).filter(h => h.items.length);
    }, g => g.length ? renderHighlights(g) : null, 6),
    runSection("sec-categories", "categories-slot", async () => (await fetchActive("categories")).sort(bySort), c => c.length ? renderCategories(c) : null),
    runSection("sec-featured", "featured-slot", async () => (await productsFresh()).filter(p => p.isFeatured === true).sort(bySort).slice(0, 8), renderProducts),
    runSection("sec-new", "new-slot", async () => (await products()).slice().sort((a, b) => millis(b.createdAt) - millis(a.createdAt)).slice(0, 8), renderProducts),
    runSection("sec-reviews", "reviews-slot", async () => {
      const snap = await getDocs(query(collection(db, "reviews"), where("isApproved", "==", true), limit(30)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => typeof r.reviewText === "string" && r.reviewText.trim())
        .sort((a, b) => millis(b.createdAt) - millis(a.createdAt)).slice(0, 6);
    }, r => r.length ? renderReviews(r) : null, 3)
  ]);
}
boot();
