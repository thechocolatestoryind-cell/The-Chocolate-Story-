// product.js — product detail: live document by ?id= (or ?slug=), gallery, data-driven options, quantity, cart, wishlist.
import { db, collection, doc, getDoc, getDocs, query, where, limit } from "./firebase.js";
import { $, el, formatINR, num, purchasable, maxQuantity, productImages, renderError, renderLoading, renderEmpty, setMeta, setWishState, showToast, MAX_QTY, priceText, whatsappLink } from "./common.js";
import { normalizeOptions, unitPrice, addToCart } from "./cart.js";
import { createWishlistController, wishHandler } from "./wishlist-reviews.js";

const slot = $("#product-detail");
const params = new URLSearchParams(location.search);
const rawId = params.get("id") || "", rawSlug = params.get("slug") || "";
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/, SLUG_RE = /^[A-Za-z0-9-]{1,120}$/;

async function fetchProduct() {
  if (rawId && ID_RE.test(rawId)) {
    try { const s = await getDoc(doc(db, "products", rawId)); return s.exists() ? { id: s.id, ...s.data() } : null; }
    catch (err) { if (err && err.code === "permission-denied") return null; throw err; } // inactive/deleted products are denied by the rules
  }
  if (rawSlug && SLUG_RE.test(rawSlug)) {
    const s = await getDocs(query(collection(db, "products"), where("slug", "==", rawSlug), where("isActive", "==", true), limit(1)));
    return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
  }
  return null;
}
async function fetchCategory(id) {
  if (!id) return null;
  try { const s = await getDoc(doc(db, "categories", id)); return s.exists() ? { id: s.id, ...s.data() } : null; } catch { return null; }
}

function gallery(p) {
  const imgs = productImages(p);
  const list = imgs.length ? imgs : [{ url: "product-placeholder.png", alt: "" }];
  let i = 0;
  const main = el("img", { class: "gallery__main", draggable: "false", src: list[0].url, alt: list[0].alt, width: 900, height: 900, decoding: "async", fetchpriority: "high" });
  main.addEventListener("error", () => { if (!main.src.endsWith("product-placeholder.png")) main.src = "product-placeholder.png"; });
  const status = el("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const counter = el("span", { class: "gallery__count", "aria-hidden": "true", hidden: list.length < 2 }, `1 / ${list.length}`);
  const thumbs = list.map((im, k) => el("button", { type: "button", class: "thumb", "aria-label": `Show photo ${k + 1} of ${list.length}`, "aria-current": k === 0 ? "true" : null, onclick: () => show(k) },
    el("img", { src: im.url, alt: "", width: 120, height: 120, loading: k < 5 ? "eager" : "lazy", onerror: function () { this.style.visibility = "hidden"; } })));
  function show(k) {
    i = (k + list.length) % list.length;
    main.src = list[i].url; main.alt = list[i].alt;
    thumbs.forEach((t, n) => n === i ? t.setAttribute("aria-current", "true") : t.removeAttribute("aria-current"));
    status.textContent = `Photo ${i + 1} of ${list.length}`;
    counter.textContent = `${i + 1} / ${list.length}`;
  }
  const multi = list.length > 1;
  const box = el("div", { class: "gallery", role: multi ? "group" : null, "aria-roledescription": multi ? "gallery" : null, "aria-label": multi ? "Product photos" : null },
    el("div", { class: "gallery__stage" }, main, counter,
      multi ? el("button", { type: "button", class: "gallery__nav gallery__nav--prev", "aria-label": "Previous photo", onclick: () => show(i - 1) }, "‹") : null,
      multi ? el("button", { type: "button", class: "gallery__nav gallery__nav--next", "aria-label": "Next photo", onclick: () => show(i + 1) }, "›") : null),
    multi ? el("div", { class: "thumbs" }, thumbs) : null, status);
  if (multi) { // swipe left/right on the main photo (vertical scrolling still works)
    const stage = box.querySelector(".gallery__stage"); let x0 = null, y0 = null;
    stage.addEventListener("pointerdown", e => { x0 = e.clientX; y0 = e.clientY; });
    stage.addEventListener("pointerup", e => { if (x0 != null && Math.abs(e.clientX - x0) > 40 && Math.abs(e.clientX - x0) > Math.abs(e.clientY - y0)) show(i + (e.clientX < x0 ? 1 : -1)); x0 = null; });
    stage.addEventListener("pointercancel", () => { x0 = null; });
  }
  if (multi) box.addEventListener("keydown", e => { if (e.key === "ArrowRight") show(i + 1); else if (e.key === "ArrowLeft") show(i - 1); });
  return box;
}

/* ---------- share ---------- */
function productUrl(p) { const u = new URL("product.html", location.href); u.search = "?id=" + encodeURIComponent(p.id); u.hash = ""; return u.href; }
function shareContent(p) {
  const url = productUrl(p), price = priceText(p);
  const body = [`🍫 ${p.name || "A treat from The Chocolate Story"}`, p.shortDescription ? String(p.shortDescription).trim() : "", [price, "100% eggless", "Delivered across India"].filter(Boolean).join(" · "), "", "Order from The Chocolate Story:"].filter((l, k) => l || k === 3).join("\n");
  return { title: `${p.name || "The Chocolate Story"} — The Chocolate Story`, text: body, url, full: body + "\n" + url };
}
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try { const t = el("textarea", { readonly: true, style: "position:fixed;opacity:0" }); t.value = text; document.body.append(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok; } catch { return false; }
}
function shareControl(p) {
  const d = shareContent(p);
  const btn = el("button", { type: "button", class: "btn btn--ghost btn--block", "aria-expanded": "false", "aria-controls": "share-menu" }, "Share this product");
  const wa = "https://wa.me/?text=" + encodeURIComponent(d.full);
  const copyBtn = el("button", { type: "button", class: "btn btn--ghost btn--block" }, "Copy link");
  const menu = el("div", { class: "sharemenu", id: "share-menu", role: "group", "aria-label": "Share options", hidden: true },
    el("a", { class: "btn btn--primary btn--block", href: wa, target: "_blank", rel: "noopener noreferrer", text: "Share on WhatsApp" }), copyBtn);
  const close = (focus) => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); if (focus) btn.focus(); };
  const open = () => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); menu.querySelector("a").focus(); };
  btn.addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({ title: d.title, text: d.text, url: d.url }); return; }
      catch (err) { if (err && err.name === "AbortError") return; /* otherwise fall back to the menu */ }
    }
    menu.hidden ? open() : close(true);
  });
  copyBtn.addEventListener("click", async () => { const ok = await copyText(d.url); showToast(ok ? "Link copied." : "Couldn't copy. Please copy the address from your browser.", { type: ok ? "success" : "error", timeout: 3000 }); if (ok) close(true); });
  menu.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(true); } });
  menu.querySelector("a").addEventListener("click", () => close(false));
  return el("div", { class: "share" }, btn, menu);
}

async function render(p) {
  const groups = normalizeOptions(p.options);
  const ok = purchasable(p);
  const cap = maxQuantity(p);
  const cat = await fetchCategory(p.categoryId);
  const wish = await createWishlistController();
  setMeta((p.seoTitle || p.name || "Product") + " — The Chocolate Story", p.seoDescription || p.shortDescription || "");

  const priceEl = el("p", { class: "buy__price", "aria-live": "polite" });
  const priceNote = el("p", { class: "buy__pricenote" });
  const msg = el("p", { class: "form-status buy__msg", role: "status" });
  const controls = new Map(); // group name -> () => selection | null

  const optionBlocks = groups.map((g, gi) => {
    if (g.kind === "text") {
      const input = el("textarea", { id: `opt-${gi}`, rows: 2, maxlength: g.maxLength, placeholder: g.placeholder || "" });
      controls.set(g.name, () => ({ group: g.name, label: "", text: input.value.trim() }));
      input.addEventListener("input", refresh);
      return el("div", { class: "opt" }, el("label", { for: `opt-${gi}`, text: g.name + (g.required ? "" : " (optional)") }), input,
        g.price ? el("p", { class: "opt__hint", text: `Adds ${formatINR(g.price)}` }) : null);
    }
    const usable = g.choices.filter(c => c.available);
    const name = `opt-${gi}`;
    const radios = g.choices.map((c, ci) => {
      const id = `${name}-${ci}`;
      return el("div", { class: "choice" + (c.available ? "" : " choice--off") },
        el("input", { type: "radio", name, id, value: c.label, disabled: !c.available, checked: g.required && usable.length === 1 && usable[0] === c }),
        el("label", { for: id }, el("span", { text: c.label }), c.price ? el("small", { text: (c.price > 0 ? "+" : "−") + formatINR(Math.abs(c.price)) }) : null, c.available ? null : el("small", { text: "Unavailable" })));
    });
    controls.set(g.name, () => { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? { group: g.name, label: r.value } : null; });
    const fs = el("fieldset", { class: "opt" }, el("legend", { text: g.name + (g.required ? "" : " (optional)") }), el("div", { class: "choices" }, radios));
    fs.addEventListener("change", refresh);
    return fs;
  });

  const collect = () => [...controls.values()].map(f => f()).filter(s => s && (s.label || s.text));
  function refresh() {
    const sel = collect(), priced = unitPrice(p, sel);
    msg.textContent = "";
    if (priced.ok) { priceEl.textContent = formatINR(priced.price); priceNote.textContent = groups.length ? "Price for your selection" : ""; }
    else { priceEl.textContent = (p.productType === "customizable" ? "From " : "") + (Number.isFinite(Number(p.basePrice)) ? formatINR(p.basePrice) : ""); priceNote.textContent = groups.length ? "Choose your options to see the final price." : ""; }
  }

  const qty = el("input", { type: "number", id: "qty", class: "qty__input", min: 1, max: cap, value: 1, inputmode: "numeric" });
  const setQ = (n) => { qty.value = Math.min(Math.max(Math.floor(n) || 1, 1), Math.max(cap, 1)); };
  const addBtn = el("button", { type: "button", class: "btn btn--primary btn--block", disabled: !ok }, ok ? "Add to cart" : "Currently unavailable");
  addBtn.addEventListener("click", () => {
    const q = Math.floor(Number(qty.value));
    if (!(q >= 1) || q > cap) { msg.textContent = `Please choose a quantity between 1 and ${cap}.`; qty.focus(); return; }
    const res = addToCart(p, collect(), q);
    msg.textContent = res.message;
    if (res.ok) showToast(res.message, { type: "success" }); else showToast(res.message, { type: "error" });
  });
  const wishBtn = el("button", { type: "button", class: "btn btn--ghost btn--block wish-btn", "aria-pressed": String(wish.has(p.id)), "aria-label": "Save " + (p.name || "product") + " to wishlist" }, "Save to wishlist");
  setWishState(wishBtn, wish.has(p.id));
  const handler = wishHandler(wish);
  wishBtn.addEventListener("click", () => handler(p, wishBtn));

  const delivery = num(p.deliveryCharge, 0);
  const view = el("div", { class: "product-layout" },
    gallery(p),
    el("div", { class: "buy-box" },
      cat ? el("p", { class: "crumbs" }, el("a", { href: "shop.html?category=" + encodeURIComponent(cat.slug || cat.id), text: cat.name || "Category" })) : null,
      el("h1", { class: "buy__title", text: p.name || "Product" }),
      p.shortDescription ? el("p", { class: "buy__short", text: p.shortDescription }) : null,
      priceEl, priceNote,
      el("p", { class: "buy__avail " + (ok ? "is-ok" : "is-off"), text: ok ? "Available to order" : "Currently unavailable" }),
      ...optionBlocks,
      ok ? el("div", { class: "opt" }, el("label", { for: "qty", text: "Quantity" }),
        el("div", { class: "qty" },
          el("button", { type: "button", class: "qty__btn", "aria-label": "Decrease quantity", onclick: () => setQ(Number(qty.value) - 1) }, "−"), qty,
          el("button", { type: "button", class: "qty__btn", "aria-label": "Increase quantity", onclick: () => { if (Number(qty.value) >= cap) showToast(`Maximum available quantity is ${cap}.`); setQ(Number(qty.value) + 1); } }, "+"))) : null,
      el("div", { class: "buy__actions" }, addBtn, wishBtn, shareControl(p)),
      msg,
      el("a", { class: "btn btn--ghost btn--block", href: "cart.html", text: "View cart" }),
      el("ul", { class: "buy__facts" },
        el("li", {}, el("strong", { text: "Delivery charge: " }), document.createTextNode(delivery ? `${formatINR(delivery)} for this product` : "Free for this product")),
        el("li", { text: "Estimated delivery is around 6–8 days from the order date — not a guaranteed date." }),
        el("li", { text: "100% eggless. Online payment only, no Cash on Delivery." }))),
    p.description ? el("section", { class: "buy__desc" }, el("h2", { text: "About this product" }), el("p", { class: "prewrap", text: p.description })) : null);
  slot.replaceChildren(view);
  document.getElementById("product-h1")?.remove();
  refresh();
}

async function boot() {
  if (!rawId && !rawSlug) return renderEmpty(slot, { title: "Choose a product", text: "Pick something from our shop to see its details.", actionText: "Browse the shop", actionHref: "shop.html" });
  renderLoading(slot, "Loading product…");
  try {
    const p = await fetchProduct();
    if (!p) { setMeta("Product not found — The Chocolate Story"); return renderEmpty(slot, { title: "We couldn't find that product", text: "It may no longer be available, or the link may be incorrect.", actionText: "Browse the shop", actionHref: "shop.html" }); }
    await render(p);
  } catch { renderError(slot, "We couldn't load this product right now. Please check your connection and try again.", boot); }
}
if (slot) boot();
