// order-logic.js — pure order maths and validation (no Firebase imports, so it can be unit-tested).
// It mirrors the storefront's cart.js rules: price = basePrice + selected option adjustments; delivery is charged ONCE per distinct product.
"use strict";

class OrderError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const MAX_QTY = 20, MAX_ITEMS = 30;
const num = (v, d = 0) => (v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v))) ? Number(v) : d;
const round2 = (n) => Math.round(n * 100) / 100;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/* ---------- options (shape written by the admin panel; tolerant of the other documented variants) ---------- */
const first = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== "") return o[k]; return ""; };
const priceOf = (o) => { for (const k of ["priceAdjustment", "priceDelta", "extraPrice", "additionalPrice", "price"]) if (o[k] !== null && o[k] !== "" && o[k] !== undefined && Number.isFinite(Number(o[k]))) return Number(o[k]); return 0; };
const TEXT_TYPES = ["text", "textarea", "input", "message", "custom"];
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => {
    if (!g || typeof g !== "object") return null;
    const name = String(first(g, ["name", "label", "title"])).trim().slice(0, 80);
    if (!name) return null;
    if (TEXT_TYPES.includes(String(g.type || "").toLowerCase())) return { name, kind: "text", required: g.required === true, price: priceOf(g), maxLength: Math.min(Math.max(num(g.maxLength, 200), 1), 500) };
    const list = first(g, ["choices", "values", "options", "items"]);
    if (!Array.isArray(list)) return null;
    const choices = list.map((c) => {
      if (typeof c === "string") return c.trim() ? { label: c.trim().slice(0, 80), price: 0, available: true } : null;
      if (c && typeof c === "object") { const label = String(first(c, ["label", "name", "title", "value"])).trim().slice(0, 80); return label ? { label, price: priceOf(c), available: !(c.isAvailable === false || c.available === false || c.isActive === false) } : null; }
      return null;
    }).filter(Boolean);
    return choices.length ? { name, kind: "choice", required: g.required !== false, choices } : null;
  }).filter(Boolean);
}

/** Returns { price, selectedOptions } or throws OrderError. selections: [{ group, label, text? }] */
function priceProduct(product, selections) {
  let price = num(product.basePrice, NaN);
  if (!Number.isFinite(price) || price < 0) throw new OrderError(409, "bad-price", `“${product.name || "A product"}” doesn't have a valid price right now.`);
  const groups = normalizeOptions(product.options);
  const picked = new Map();
  for (const s of selections) { if (picked.has(s.group)) throw new OrderError(400, "bad-options", "A product option was submitted twice."); picked.set(s.group, s); }
  const selectedOptions = [];
  for (const g of groups) {
    const s = picked.get(g.name);
    if (g.kind === "choice") {
      if (!s || !s.label) { if (g.required) throw new OrderError(409, "option-required", `Please choose ${g.name} for “${product.name}”.`); continue; }
      const c = g.choices.find((x) => x.label === s.label);
      if (!c || !c.available) throw new OrderError(409, "option-unavailable", `“${s.label}” is no longer available for ${g.name}.`);
      price += c.price; selectedOptions.push({ name: g.name, value: c.label });
    } else {
      const text = typeof s?.text === "string" ? s.text.trim() : "";
      if (!text) { if (g.required) throw new OrderError(409, "option-required", `Please fill in ${g.name} for “${product.name}”.`); continue; }
      if (text.length > g.maxLength) throw new OrderError(400, "option-too-long", `${g.name} is too long.`);
      price += g.price; selectedOptions.push({ name: g.name, value: text });
    }
  }
  for (const s of selections) if (!groups.some((g) => g.name === s.group)) throw new OrderError(409, "option-removed", `Option “${s.group}” is no longer offered for “${product.name}”.`);
  if (price < 0) throw new OrderError(409, "bad-price", "Price could not be calculated.");
  return { price: round2(price), selectedOptions };
}

function purchasable(p) {
  if (!p || p.isActive !== true || p.isAvailable === false) return false;
  if (p.trackInventory === true && Number.isFinite(Number(p.stockQuantity)) && Number(p.stockQuantity) <= 0 && p.allowBackorder !== true) return false;
  return true;
}
function maxQuantity(p) {
  if (p.trackInventory === true && p.allowBackorder !== true && Number.isFinite(Number(p.stockQuantity))) return Math.max(0, Math.min(MAX_QTY, Math.floor(Number(p.stockQuantity))));
  return MAX_QTY;
}

/** Validates the request body shape. Throws OrderError(400). */
function parseCreateBody(body) {
  const bad = (m) => { throw new OrderError(400, "bad-request", m); };
  if (!body || typeof body !== "object") bad("Invalid request.");
  const { clientRequestId, addressId, customerNote, items } = body;
  if (typeof clientRequestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) bad("Invalid request reference.");
  if (typeof addressId !== "string" || !ID_RE.test(addressId)) bad("Please choose a delivery address.");
  if (customerNote != null && typeof customerNote !== "string") bad("Invalid order note.");
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) bad("Your cart is empty or too large.");
  const lines = items.map((it) => {
    if (!it || typeof it !== "object" || typeof it.productId !== "string" || !ID_RE.test(it.productId)) bad("Invalid cart item.");
    const quantity = it.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) bad("Invalid quantity.");
    const sel = it.selections == null ? [] : it.selections;
    if (!Array.isArray(sel) || sel.length > 20) bad("Invalid product options.");
    const selections = sel.map((s) => {
      if (!s || typeof s !== "object" || typeof s.group !== "string" || (s.label != null && typeof s.label !== "string") || (s.text != null && typeof s.text !== "string")) bad("Invalid product options.");
      return { group: s.group.slice(0, 80), label: String(s.label || "").slice(0, 80), text: typeof s.text === "string" ? s.text.slice(0, 500) : "" };
    });
    return { productId: it.productId, quantity, selections };
  });
  return { clientRequestId, addressId, customerNote: String(customerNote || "").trim().slice(0, 300), lines };
}

/**
 * Builds the order's items and totals from live product documents.
 * products: Map(productId -> product data). Delivery is charged once per distinct product.
 */
function buildItems(lines, products) {
  const items = [], delivery = new Map();
  let subtotal = 0;
  for (const l of lines) {
    const p = products.get(l.productId);
    if (!p || p.isActive !== true) throw new OrderError(409, "product-gone", "A product in your cart is no longer available. Please review your cart.");
    if (!purchasable(p)) throw new OrderError(409, "product-unavailable", `“${p.name || "A product"}” is currently unavailable.`);
    const priced = priceProduct(p, l.selections);
    // total quantity of this product across all lines must respect its stock/quantity limit
    const sameProductQty = lines.filter((x) => x.productId === l.productId).reduce((s, x) => s + x.quantity, 0);
    if (p.trackInventory === true && p.allowBackorder !== true && Number.isFinite(Number(p.stockQuantity)) && sameProductQty > Number(p.stockQuantity)) throw new OrderError(409, "insufficient-stock", `Only a limited quantity of “${p.name}” is available. Please reduce the quantity.`);
    if (l.quantity > maxQuantity(p)) throw new OrderError(409, "insufficient-stock", `Only ${maxQuantity(p)} of “${p.name}” can be ordered right now.`);
    const lineTotal = round2(priced.price * l.quantity);
    subtotal += lineTotal;
    if (!delivery.has(l.productId)) delivery.set(l.productId, Math.max(0, num(p.deliveryCharge, 0)));
    const image = typeof p.primaryImage === "string" ? p.primaryImage : (Array.isArray(p.images) && typeof p.images[0] === "string" ? p.images[0] : "");
    items.push({ productId: l.productId, name: String(p.name || "Product").slice(0, 160), image, quantity: l.quantity, unitPrice: priced.price, lineTotal, selectedOptions: priced.selectedOptions });
  }
  const deliveryCharge = round2([...delivery.values()].reduce((s, d) => s + d, 0));
  subtotal = round2(subtotal);
  return { items, subtotal, deliveryCharge, totalAmount: round2(subtotal + deliveryCharge) };
}

const orderNumber = (year, seq) => `TCS-${year}-${String(seq).padStart(4, "0")}`;
const istYear = (d) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(d));
/** Customers may cancel only BEFORE an order is shipped. */
const CANCELLABLE = ["pending", "confirmed", "processing"];
const canCustomerCancel = (status) => CANCELLABLE.includes(String(status || "").toLowerCase());

module.exports = { OrderError, MAX_QTY, MAX_ITEMS, ID_RE, normalizeOptions, priceProduct, purchasable, maxQuantity, parseCreateBody, buildItems, orderNumber, istYear, canCustomerCancel, round2 };
