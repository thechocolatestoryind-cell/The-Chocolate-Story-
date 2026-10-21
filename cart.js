// cart.js — persistent cart state, price/delivery calculations and the cart page.
// Cart contents in localStorage are a convenience only: every price/stock value is re-read from Firestore when the
// cart opens, and a trusted backend must re-verify everything before an order is created (Stage 4).
import { db, doc, getDoc } from "./firebase.js";
import { CART_KEY, MAX_QTY, $, el, formatINR, safeUrl, num, purchasable, maxQuantity, productImages, renderEmpty, renderError, renderLoading, showToast } from "./common.js";

/* ---------- options (built only from the product's own `options` data) ---------- */
// The sample export has no options data, so this reader is tolerant. Supported group shapes:
//   { name|label|title, type?: "select|radio|choice" | "text|textarea|input|message", required?, choices|values|options|items: [ "A" | { label|name|title|value, priceAdjustment|priceDelta|extraPrice|additionalPrice|price, isAvailable? } ] }
// Text groups may carry a `price`, `maxLength` and `placeholder`.
const first = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== "") return o[k]; return ""; };
const priceOf = (o) => { for (const k of ["priceAdjustment", "priceDelta", "extraPrice", "additionalPrice", "price"]) if (o[k] !== null && o[k] !== "" && o[k] !== undefined && Number.isFinite(Number(o[k]))) return Number(o[k]); return 0; };
const TEXT_TYPES = ["text", "textarea", "input", "message", "custom"];
export function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(g => {
    if (!g || typeof g !== "object") return null;
    const name = String(first(g, ["name", "label", "title"])).trim().slice(0, 80);
    if (!name) return null;
    if (TEXT_TYPES.includes(String(g.type || "").toLowerCase())) {
      return { name, kind: "text", required: g.required === true, price: priceOf(g), maxLength: Math.min(Math.max(num(g.maxLength, 200), 1), 500), placeholder: String(g.placeholder || "").slice(0, 120) };
    }
    const list = first(g, ["choices", "values", "options", "items"]);
    if (!Array.isArray(list)) return null;
    const choices = list.map(c => {
      if (typeof c === "string") return c.trim() ? { label: c.trim().slice(0, 80), price: 0, available: true } : null;
      if (c && typeof c === "object") {
        const label = String(first(c, ["label", "name", "title", "value"])).trim().slice(0, 80);
        return label ? { label, price: priceOf(c), available: !(c.isAvailable === false || c.available === false || c.isActive === false) } : null;
      }
      return null;
    }).filter(Boolean);
    return choices.length ? { name, kind: "choice", required: g.required !== false, choices } : null;
  }).filter(Boolean);
}

/** Unit price = basePrice + price adjustments of the selected options (only where the option data defines prices). */
export function unitPrice(product, selections) {
  let price = num(product && product.basePrice, NaN);
  if (!Number.isFinite(price) || price < 0) return { ok: false, reason: "This product doesn't have a valid price." };
  const groups = normalizeOptions(product.options);
  const picked = new Map((selections || []).map(s => [s.group, s]));
  for (const g of groups) {
    const s = picked.get(g.name);
    if (g.kind === "choice") {
      if (!s) { if (g.required) return { ok: false, reason: `Please choose ${g.name}.` }; continue; }
      const c = g.choices.find(x => x.label === s.label);
      if (!c || !c.available) return { ok: false, reason: `“${s.label}” is no longer available for ${g.name}.` };
      price += c.price;
    } else {
      const text = s && typeof s.text === "string" ? s.text.trim() : "";
      if (!text) { if (g.required) return { ok: false, reason: `Please fill in ${g.name}.` }; continue; }
      if (text.length > g.maxLength) return { ok: false, reason: `${g.name} is too long.` };
      price += g.price;
    }
  }
  for (const s of selections || []) if (!groups.some(g => g.name === s.group)) return { ok: false, reason: `Option “${s.group}” is no longer offered.` };
  return { ok: true, price: Math.round(price * 100) / 100 };
}

/* ---------- storage ---------- */
export function selectionKey(productId, selections) {
  const s = (selections || []).map(x => `${x.group}=${x.label || ""}${x.text ? "#" + x.text : ""}`).sort().join("|");
  return productId + "::" + s;
}
function cleanLine(i) {
  if (!i || typeof i !== "object" || typeof i.productId !== "string" || !i.productId || !Number.isInteger(i.quantity) || i.quantity < 1) return null;
  const selections = (Array.isArray(i.selections) ? i.selections : []).filter(s => s && typeof s.group === "string").slice(0, 20)
    .map(s => ({ group: s.group.slice(0, 80), label: String(s.label || "").slice(0, 80), ...(typeof s.text === "string" && s.text ? { text: s.text.slice(0, 500) } : {}) }));
  return { key: selectionKey(i.productId, selections), productId: i.productId.slice(0, 128), name: String(i.name || "Product").slice(0, 160), image: safeUrl(i.image) || "",
    selections, quantity: Math.min(i.quantity, MAX_QTY), unitPrice: num(i.unitPrice, 0), deliveryCharge: num(i.deliveryCharge, 0) };
}
/** Defensive load: corrupted/unexpected storage yields an empty cart; duplicate lines are merged. */
export function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
    const map = new Map();
    for (const it of items) {
      const c = cleanLine(it); if (!c) continue;
      const prev = map.get(c.key);
      if (prev) prev.quantity = Math.min(MAX_QTY, prev.quantity + c.quantity); else map.set(c.key, c);
    }
    return [...map.values()];
  } catch { return []; }
}
export function saveCart(items) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(items)); window.dispatchEvent(new Event("tcs:cart-changed")); return true; }
  catch { return false; }
}

/** Adds a product to the cart; identical product + options merge into one line. */
export function addToCart(product, selections, quantity) {
  const priced = unitPrice(product, selections);
  if (!priced.ok) return { ok: false, message: priced.reason };
  if (!purchasable(product)) return { ok: false, message: "This product is currently unavailable." };
  const q = Math.floor(Number(quantity));
  if (!(q >= 1)) return { ok: false, message: "Please choose a quantity of at least 1." };
  const cart = loadCart();
  const line = cleanLine({ productId: product.id, name: product.name, image: (productImages(product)[0] || {}).url, selections, quantity: Math.min(q, MAX_QTY), unitPrice: priced.price, deliveryCharge: num(product.deliveryCharge, 0) });
  const cap = maxQuantity(product);
  const existing = cart.find(l => l.key === line.key);
  let note = "";
  if (existing) {
    const total = existing.quantity + line.quantity;
    existing.quantity = Math.min(total, cap);
    if (total > cap) note = ` Quantity limited to ${cap}.`;
    Object.assign(existing, { unitPrice: line.unitPrice, deliveryCharge: line.deliveryCharge, name: line.name, image: line.image });
  } else {
    line.quantity = Math.min(line.quantity, cap);
    if (line.quantity < q) note = ` Quantity limited to ${line.quantity}.`;
    cart.push(line);
  }
  if (!saveCart(cart)) return { ok: false, message: "Your browser wouldn't save the cart (private mode or storage full)." };
  return { ok: true, message: "Added to your cart." + note };
}

/**
 * THE single delivery/total calculation. Policy (until the owner says otherwise): each distinct product's configured
 * `deliveryCharge` is charged ONCE per product, never per unit and never again for duplicate lines of the same product.
 * Lines: [{ productId, name, unitPrice, quantity, deliveryCharge }]
 */
export function calculateTotals(lines) {
  let subtotal = 0, itemCount = 0;
  const delivery = new Map();
  for (const l of lines) {
    subtotal += l.unitPrice * l.quantity; itemCount += l.quantity;
    if (!delivery.has(l.productId)) delivery.set(l.productId, { productId: l.productId, name: l.name, charge: Math.max(0, l.deliveryCharge) });
  }
  const deliveryByProduct = [...delivery.values()];
  const deliveryTotal = deliveryByProduct.reduce((s, d) => s + d.charge, 0);
  const r = (n) => Math.round(n * 100) / 100;
  return { subtotal: r(subtotal), deliveryByProduct, deliveryTotal: r(deliveryTotal), total: r(subtotal + deliveryTotal), itemCount };
}

/* ---------- live revalidation ---------- */
async function fetchProduct(id) {
  try {
    const snap = await getDoc(doc(db, "products", id));
    return snap.exists() ? { status: "ok", product: { id: snap.id, ...snap.data() } } : { status: "gone" };
  } catch (err) {
    // Inactive or deleted products are denied by the rules: treat as no longer available. Anything else = could not verify.
    return err && err.code === "permission-denied" ? { status: "gone" } : { status: "error" };
  }
}
export async function resolveCartLines(lines) {
  const ids = [...new Set(lines.map(l => l.productId))];
  const found = new Map((await Promise.all(ids.map(async id => [id, await fetchProduct(id)]))));
  return lines.map(line => {
    const r = found.get(line.productId), notices = [];
    const view = { line, status: "ok", product: null, unit: line.unitPrice, delivery: line.deliveryCharge, qty: line.quantity, notices };
    if (r.status === "error") { view.status = "unverified"; notices.push("We couldn't refresh this item's price just now. It will be re-checked at checkout."); return view; }
    if (r.status === "gone") { view.status = "unavailable"; notices.push("This item is no longer available."); return view; }
    const p = r.product; view.product = p;
    if (!purchasable(p)) { view.status = "unavailable"; notices.push("This item is currently unavailable."); return view; }
    const priced = unitPrice(p, line.selections);
    if (!priced.ok) { view.status = "unavailable"; notices.push(priced.reason + " Please remove it and choose again."); return view; }
    if (Math.abs(priced.price - line.unitPrice) > 0.004) notices.push(`The price changed from ${formatINR(line.unitPrice)} to ${formatINR(priced.price)}.`);
    view.unit = priced.price; view.delivery = num(p.deliveryCharge, 0);
    const cap = maxQuantity(p);
    if (line.quantity > cap) { view.qty = cap; notices.push(`Quantity reduced to ${cap} based on current availability.`); }
    const img = productImages(p)[0];
    line.unitPrice = view.unit; line.deliveryCharge = view.delivery; line.quantity = view.qty; line.name = p.name || line.name; if (img) line.image = img.url;
    return view;
  });
}

/* ---------- cart page ---------- */
function initCartPage(slot) {
  let views = [], refreshed = false;
  const live = el("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const persist = () => saveCart(views.map(v => v.line));
  const capFor = (v) => v.product ? maxQuantity(v.product) : MAX_QTY;

  function lineEl(v) {
    const { line } = v, bad = v.status === "unavailable";
    const img = el("img", { src: line.image || "product-placeholder.png", alt: "", width: 96, height: 96, loading: "lazy", onerror: function () { if (!this.src.endsWith("product-placeholder.png")) this.src = "product-placeholder.png"; } });
    const setQty = (n) => {
      const q = Math.min(Math.max(n, 1), capFor(v));
      if (q === v.qty) { if (n > q) showToast(`Maximum available quantity is ${q}.`); return; }
      v.qty = q; v.line.quantity = q; persist(); render(); live.textContent = `${line.name} quantity ${q}`;
    };
    const qtyInput = el("input", { type: "number", class: "qty__input", min: 1, max: capFor(v), value: v.qty, inputmode: "numeric", "aria-label": `Quantity for ${line.name}`, disabled: bad });
    qtyInput.addEventListener("change", () => setQty(Math.floor(Number(qtyInput.value)) || 1));
    return el("li", { class: "line" + (bad ? " line--bad" : "") },
      el("a", { class: "line__img", href: "product.html?id=" + encodeURIComponent(line.productId), tabindex: "-1", "aria-hidden": "true" }, img),
      el("div", { class: "line__main" },
        el("a", { class: "line__name", href: "product.html?id=" + encodeURIComponent(line.productId), text: line.name }),
        line.selections.length ? el("ul", { class: "line__opts" }, line.selections.map(s => el("li", { text: `${s.group}: ${s.text || s.label}` }))) : null,
        bad ? null : el("p", { class: "line__unit", text: formatINR(v.unit) + " each" }),
        v.notices.map(n => el("p", { class: "line__note" + (bad ? " line__note--bad" : ""), role: bad ? "alert" : null, text: n })),
        el("div", { class: "line__actions" },
          bad ? null : el("div", { class: "qty" },
            el("button", { type: "button", class: "qty__btn", "aria-label": `Decrease quantity of ${line.name}`, onclick: () => setQty(v.qty - 1), disabled: v.qty <= 1 }, "−"),
            qtyInput,
            el("button", { type: "button", class: "qty__btn", "aria-label": `Increase quantity of ${line.name}`, onclick: () => setQty(v.qty + 1), disabled: v.qty >= capFor(v) }, "+")),
          el("button", { type: "button", class: "link-btn", onclick: () => { views = views.filter(x => x !== v); persist(); render(); live.textContent = `${line.name} removed from cart`; } }, "Remove"))),
      el("p", { class: "line__total", text: bad ? "—" : formatINR(v.unit * v.qty) }));
  }

  function summaryEl() {
    const usable = views.filter(v => v.status !== "unavailable");
    const t = calculateTotals(usable.map(v => ({ productId: v.line.productId, name: v.line.name, unitPrice: v.unit, quantity: v.qty, deliveryCharge: v.delivery })));
    const blocked = views.some(v => v.status === "unavailable");
    const unverified = views.some(v => v.status === "unverified");
    const cta = (blocked || !usable.length)
      ? el("button", { type: "button", class: "btn btn--primary btn--block", disabled: true, "aria-disabled": "true" }, "Proceed to checkout")
      : el("a", { class: "btn btn--primary btn--block", href: "checkout.html", text: "Proceed to checkout" });
    return el("aside", { class: "summary-card", "aria-label": "Order summary" },
      el("h2", { text: "Order summary" }),
      el("div", { class: "summary-row" }, el("span", { text: `Items (${t.itemCount})` }), el("span", { text: formatINR(t.subtotal) })),
      el("div", { class: "summary-sub" }, el("p", { class: "summary-sub__title", text: "Delivery charges" }),
        t.deliveryByProduct.length ? el("ul", {}, t.deliveryByProduct.map(d => el("li", { class: "summary-row summary-row--small" }, el("span", { text: d.name }), el("span", { text: d.charge ? formatINR(d.charge) : "Free" })))) : null,
        el("p", { class: "summary-note", text: "Each product’s delivery charge is applied once, however many you buy." })),
      el("div", { class: "summary-row" }, el("span", { text: "Delivery total" }), el("span", { text: formatINR(t.deliveryTotal) })),
      el("div", { class: "summary-row summary-row--total" }, el("span", { text: unverified ? "Estimated total" : "Total" }), el("span", { text: formatINR(t.total) })),
      blocked ? el("p", { class: "line__note line__note--bad", role: "alert", text: "Remove unavailable items to continue." }) : null,
      unverified ? el("p", { class: "line__note", text: "Some prices couldn't be refreshed, so this total is an estimate." }) : null,
      cta,
      el("p", { class: "summary-note", text: "Final prices and availability are confirmed securely at checkout. Online payment only — no Cash on Delivery. Delivery is usually around 6–8 days from the order date (an estimate, not a guarantee)." }),
      el("a", { class: "btn btn--ghost btn--block", href: "shop.html", text: "Continue shopping" }));
  }

  function render() {
    if (!views.length) {
      renderEmpty(slot, { title: "Your cart is empty", text: "Find something sweet in our shop and it will wait for you here.", image: "empty-cart.png", actionText: "Start shopping", actionHref: "shop.html" });
      slot.append(live); return;
    }
    const clear = el("button", { type: "button", class: "link-btn", onclick: () => { if (confirm("Remove everything from your cart?")) { views = []; persist(); render(); } } }, "Clear cart");
    slot.replaceChildren(el("div", { class: "cart-layout" },
      el("div", { class: "cart-main" }, el("div", { class: "cart-main__head" }, el("h2", { text: "Your items" }), clear), el("ul", { class: "lines" }, views.map(lineEl))),
      summaryEl()), live);
  }

  async function load() {
    const lines = loadCart();
    if (!lines.length) { views = []; render(); return; }
    renderLoading(slot, "Checking the latest prices…");
    try {
      views = await resolveCartLines(lines);
      persist();
      if (views.some(v => v.status === "unverified")) showToast("You appear to be offline or the shop can't be reached. Showing saved prices.", { type: "error", timeout: 7000 });
    } catch { views = lines.map(line => ({ line, status: "unverified", product: null, unit: line.unitPrice, delivery: line.deliveryCharge, qty: line.quantity, notices: ["We couldn't refresh this item's price just now. It will be re-checked at checkout."] })); }
    render();
  }
  window.addEventListener("storage", e => { if (e.key === CART_KEY) load(); });
  load();
}

const slot = $("#cart-contents");
if (slot) initCartPage(slot);
