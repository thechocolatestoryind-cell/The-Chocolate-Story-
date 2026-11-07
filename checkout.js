// checkout.js — review → delivery address → Pay with any UPI App → Confirm Purchase → order saved → WhatsApp payment-proof handoff.
// PAYMENT MODEL (manual, no gateway, no backend): opening a UPI app proves nothing. Confirm Purchase only SUBMITS the order as
// "pending_payment_verification"; the administrator verifies the real bank/UPI credit and approves it. Prices come from the existing
// storefront calculation (client-side), so the admin must compare the received amount with the order before approving.
import { $, el, formatINR, whatsappLink, getPublicSettings, renderEmpty, renderError, renderLoading, renderInactive, showToast, buildUpiUri, UPI_CONFIG } from "./common.js";
import { requireProfile, getUserProfile } from "./auth.js";
import { loadCart, saveCart, resolveCartLines, calculateTotals } from "./cart.js";
import { listAddresses, reconcileDefault, createAddress, buildAddressForm, addressLines } from "./addresses.js";
import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase.js";

const slot = $("#checkout-contents");
const ATTEMPT_KEY = "tcs_checkout_attempt_v2";
const ORDER_STATUS_NEW = "pending_payment_verification", PAYMENT_STATUS_NEW = "pending_verification";

/* ---------- stable order identity (prevents duplicate orders on double-click, refresh or retry) ---------- */
const randomId = () => { const a = new Uint8Array(20); (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); })); return "o" + [...a].map(b => (b % 36).toString(36)).join(""); };
const istStamp = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "2-digit", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
const fingerprint = (lines) => lines.map(l => `${l.productId}|${l.quantity}|${(l.selections || []).map(s => `${s.group}=${s.label || ""}#${s.text || ""}`).sort().join(";")}`).sort().join("~");
/** One attempt record per distinct cart. Same cart → same order ID until the order is saved and the cart cleared. */
function getAttempt(lines, uid) {
  const fp = uid + "::" + fingerprint(lines);
  try { const a = JSON.parse(localStorage.getItem(ATTEMPT_KEY) || "null"); if (a && a.fp === fp && /^[A-Za-z0-9_-]{8,64}$/.test(a.id) && a.number) return a; } catch { /* regenerate */ }
  const id = randomId(), a = { fp, id, number: "TCS-" + istStamp() + "-" + id.slice(-5).toUpperCase() };
  try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch { /* still works for this page view */ }
  return a;
}
const clearAttempt = () => { try { localStorage.removeItem(ATTEMPT_KEY); } catch { /* ignore */ } };

/** Plain-text order summary used for the WhatsApp message (selections and delivery included). */
function waMessage(o, addr) {
  const lines = o.items.map((i, n) => `${n + 1}. ${i.name} × ${i.quantity} @ ${formatINR(i.unitPrice)} = ${formatINR(i.lineTotal)}` + (i.selections.length ? "\n   Customisation: " + i.selections.map(s => `${s.group}: ${s.text || s.label}`).join("; ") : ""));
  return ["Hello The Chocolate Story! I have placed an order and paid via UPI. My payment screenshot is attached for verification.", "",
    `Order ID: ${o.id}`, `Order number: ${o.orderNumber}`, `Name: ${o.customerName}`, `Email: ${o.customerEmail}`, o.customerPhone ? `Phone: ${o.customerPhone}` : "",
    `Delivery address: ${addressLines(addr).filter(l => !l.startsWith("Phone:")).join(", ")}`, "", "Items:", ...lines, "",
    `Delivery charge: ${formatINR(o.deliveryCharge)}`, `Final total: ${formatINR(o.totalAmount)}`, "Payment method: UPI", "Payment status: Pending Verification"].filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n");
}

async function init() {
  const ctx = await requireProfile(); if (!ctx) return;
  if (ctx.inactive) return renderInactive(slot);
  const { user, profile } = ctx;
  const settings = await getPublicSettings();
  let views = [], addresses = [], selected = "", adding = false, placing = false, totals = null, noteText = "", agreed = false, attempt = null, upiTried = false;
  const live = el("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });

  async function load() {
    const lines = loadCart();
    if (!lines.length) return renderEmpty(slot, { title: "Your cart is empty", text: "Add something sweet before checking out.", image: "empty-cart.png", actionText: "Start shopping", actionHref: "shop.html" });
    renderLoading(slot, "Preparing your checkout…");
    try {
      views = await resolveCartLines(lines); saveCart(views.map(v => v.line));
      Object.assign(profile, await getUserProfile(user));
      addresses = await listAddresses(user.uid);
      const def = await reconcileDefault(user.uid, addresses, profile);
      selected = addresses.some(a => a.id === selected) ? selected : (def || (addresses[0] && addresses[0].id) || "");
      adding = addresses.length === 0;
      attempt = getAttempt(views.filter(v => v.status !== "unavailable").map(v => ({ ...v.line, quantity: v.qty })), user.uid);
      // A previous attempt may already have been saved (e.g. page refreshed or cart-clear interrupted): show it instead of creating another.
      const existing = await fetchOrder(attempt.id);
      if (existing) { saveCart([]); clearAttempt(); return submitted(existing, true); }
    } catch { return renderError(slot, "We couldn't prepare your checkout. Please check your connection and try again.", load); }
    render();
  }
  async function fetchOrder(id) {
    try { const s = await getDoc(doc(db, "orders", id)); return s.exists() && s.data().userId === user.uid ? { id: s.id, ...s.data() } : null; }
    catch (err) { if (err && err.code === "permission-denied") return null; throw err; }
  }
  const blocked = () => views.some(v => v.status === "unavailable");
  const unverified = () => views.some(v => v.status === "unverified");

  function summary(agreeBox, noteBox) {
    const usable = views.filter(v => v.status !== "unavailable");
    totals = calculateTotals(usable.map(v => ({ productId: v.line.productId, name: v.line.name, unitPrice: v.unit, quantity: v.qty, deliveryCharge: v.delivery })));
    const addr = addresses.find(a => a.id === selected);
    const ready = !blocked() && !unverified() && usable.length && addr && agreeBox.checked && !placing;
    const upiUri = attempt ? buildUpiUri(totals.total, attempt.number) : "";
    const upiBtn = el("a", { class: "btn btn--caramel btn--block", id: "upi-btn", href: upiUri, role: "button" }, "Pay with any UPI App");
    upiBtn.addEventListener("click", () => { upiTried = true; showToast("After paying, come back here and tap Confirm Purchase.", { timeout: 6000 }); });
    const copyBtn = el("button", { type: "button", class: "link-btn" }, "Copy UPI ID");
    copyBtn.addEventListener("click", async () => { try { await navigator.clipboard.writeText(UPI_CONFIG.vpa); showToast("UPI ID copied.", { type: "success", timeout: 2000 }); } catch { showToast("Couldn't copy — please select the UPI ID manually.", { type: "error" }); } });
    const confirmBtn = el("button", { type: "button", class: "btn btn--primary btn--block", id: "confirm-btn", disabled: !ready }, placing ? "Submitting your order…" : "Confirm Purchase");
    confirmBtn.addEventListener("click", () => confirmPurchase(addr, noteBox.value, usable));
    return el("aside", { class: "summary-card", "aria-label": "Order summary" }, el("h2", { text: "Order summary" }),
      el("ul", { class: "mini-lines" }, usable.map(v => el("li", { class: "summary-row summary-row--small" }, el("span", { text: `${v.line.name} × ${v.qty}` + (v.line.selections.length ? ` (${v.line.selections.map(s => s.text || s.label).join(", ")})` : "") }), el("span", { text: formatINR(v.unit * v.qty) })))),
      el("div", { class: "summary-row" }, el("span", { text: "Items" }), el("span", { text: formatINR(totals.subtotal) })),
      el("div", { class: "summary-row" }, el("span", { text: "Delivery" }), el("span", { text: formatINR(totals.deliveryTotal) })),
      el("div", { class: "summary-row summary-row--total" }, el("span", { text: "Total payable" }), el("span", { text: formatINR(totals.total) })),
      unverified() ? el("p", { class: "line__note line__note--bad", role: "alert", text: "We couldn't refresh some prices. Please check your connection and reload this page before paying." }) : null,
      el("div", { class: "upi-box" }, el("h3", { text: "Payment" }),
        el("p", { class: "summary-note", text: `Step 1: pay ${formatINR(totals.total)} using any UPI app. We'll add your order reference ${attempt ? attempt.number : ""} as the payment note.` }),
        upiBtn,
        el("p", { class: "summary-note" }, "If no UPI app opens (for example on a computer), pay manually to UPI ID ", el("strong", { text: UPI_CONFIG.vpa }), " (" + UPI_CONFIG.payeeName + ") with note ", el("strong", { text: attempt ? attempt.number : "" }), ". ", copyBtn),
        el("p", { class: "summary-note", text: "Opening a UPI app does not complete or confirm your order." }),
        el("p", { class: "summary-note", text: "Step 2: after paying, return here and tap Confirm Purchase. This submits your order and asks us to verify your payment — it is not payment confirmation." })),
      confirmBtn,
      el("p", { class: "summary-note", text: "Your order is confirmed only after we verify the payment in our bank/UPI records. UPI payment only — no Cash on Delivery. Delivery is usually around 6–8 days from the order date (an estimate, not a guarantee)." }),
      el("a", { class: "btn btn--ghost btn--block", href: "cart.html", text: "Back to cart" }));
  }

  function render() {
    const agree = el("input", { type: "checkbox", id: "agree", checked: agreed });
    const note = el("textarea", { id: "note", rows: 2, maxlength: 300, placeholder: "e.g. gift message or delivery instruction (optional)" });
    note.value = noteText; note.addEventListener("input", () => { noteText = note.value; });
    let sum = summary(agree, note);
    const refreshSum = () => { const n = summary(agree, note); sum.replaceWith(n); sum = n; };
    agree.addEventListener("change", () => { agreed = agree.checked; refreshSum(); });
    const addrBlock = el("fieldset", { class: "panel" }, el("legend", { text: "Delivery address" }),
      addresses.length ? el("div", { class: "addr-choices", role: "radiogroup", "aria-label": "Saved addresses" }, addresses.map(a => el("label", { class: "addr-choice" + (a.id === selected ? " is-on" : ""), for: "ad-" + a.id },
        el("input", { type: "radio", name: "addr", id: "ad-" + a.id, value: a.id, checked: a.id === selected, onchange: () => { selected = a.id; render(); } }),
        el("span", {}, addressLines(a).map((l, i) => el(i === 0 ? "strong" : "span", { class: "block", text: l })))))) : null,
      adding ? buildAddressForm({ idPrefix: "co", defaultChecked: addresses.length === 0, showDefault: addresses.length > 0, submitLabel: "Save and deliver here", onCancel: addresses.length ? () => { adding = false; render(); } : null,
        onSubmit: async (clean, o) => { const id = await createAddress(user.uid, clean, { makeDefault: o.makeDefault, existing: addresses }); selected = id; adding = false; showToast("Address saved.", { type: "success", timeout: 2500 }); await load(); } })
        : el("button", { type: "button", class: "btn btn--ghost", onclick: () => { adding = true; render(); } }, "Add a new address"),
      el("p", { class: "form-hint", text: "Manage all your addresses on the " }, el("a", { href: "addresses.html", text: "Saved addresses" }), document.createTextNode(" page.")));
    const confirmBlock = el("fieldset", { class: "panel" }, el("legend", { text: "Confirm and note" }),
      el("label", { for: "note", text: "Order note (optional)" }), note,
      el("label", { class: "check", for: "agree" }, agree, el("span", { text: "I've checked that my delivery address and phone number are correct." })));
    const blockedMsg = blocked() ? el("p", { class: "line__note line__note--bad", role: "alert" }, "Some items in your cart are no longer available. ", el("a", { href: "cart.html", text: "Review your cart" }), document.createTextNode(" to continue.")) : null;
    slot.replaceChildren(el("div", { class: "cart-layout" }, el("div", { class: "checkout-main" }, blockedMsg, addrBlock, confirmBlock), sum), live);
  }

  /** Saves the order. The cart is cleared ONLY after Firestore accepted the write. */
  async function confirmPurchase(addr, customerNote, usable) {
    if (placing) return; placing = true; render(); live.textContent = "Submitting your order…";
    try {
      if (!user || !addr || !usable.length || !attempt) throw Object.assign(new Error("invalid"), { code: "app/invalid" });
      const existing = await fetchOrder(attempt.id);            // retry-safe: never create a second order for the same attempt
      if (existing) { saveCart([]); clearAttempt(); return submitted(existing, true); }
      const items = usable.map(v => ({ productId: v.line.productId, name: String(v.line.name).slice(0, 160), quantity: v.qty, unitPrice: v.unit, lineTotal: Math.round(v.unit * v.qty * 100) / 100,
        deliveryCharge: v.delivery, selections: v.line.selections.map(s => ({ group: s.group, label: s.label || "", ...(s.text ? { text: s.text } : {}) })) }));
      const shippingAddress = { fullName: addr.fullName, phone: addr.phone, addressLine1: addr.addressLine1, addressLine2: addr.addressLine2 || "", landmark: addr.landmark || "", city: addr.city, state: addr.state, pincode: addr.pincode, country: "India" };
      const data = { orderVersion: 2, userId: user.uid, clientRequestId: attempt.id, orderNumber: attempt.number,
        customerName: String(profile.displayName || user.displayName || addr.fullName).slice(0, 120), customerEmail: user.email, customerPhone: addr.phone,
        addressId: addr.id, shippingAddress, items, subtotal: totals.subtotal, deliveryCharge: totals.deliveryTotal, totalAmount: totals.total, currency: "INR",
        paymentMethod: "UPI", paymentStatus: PAYMENT_STATUS_NEW, status: ORDER_STATUS_NEW,
        customerNote: String(customerNote || "").trim().slice(0, 300), adminNote: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
      await setDoc(doc(db, "orders", attempt.id), data);          // rules allow create only; a repeat write to the same ID is rejected
      let saved = await fetchOrder(attempt.id);
      saved = saved || { id: attempt.id, ...data, createdAt: new Date(), updatedAt: new Date() };
      saveCart([]); clearAttempt();
      submitted(saved, false);
    } catch (err) {
      placing = false; render();
      const msg = err && err.code === "permission-denied" ? "We couldn't save your order because the details were not accepted. Please reload the page and try again."
        : err && err.code === "app/invalid" ? "Please choose a delivery address and review your cart, then try again." : "We couldn't save your order. Please check your connection and tap Confirm Purchase again — your cart has not been cleared and you won't be charged twice by retrying here.";
      slot.prepend(el("div", { class: "state state--error", role: "alert" }, el("p", { text: msg }), el("p", { class: "summary-note", text: "If you already paid by UPI, don't pay again — retry, or message us on WhatsApp with your payment screenshot." })));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function submitted(order, resumed) {
    const items = (order.items || []).map(i => ({ name: String(i.name || "Item"), quantity: Number(i.quantity) || 1, unitPrice: Number(i.unitPrice) || 0, lineTotal: Number(i.lineTotal) || 0, selections: Array.isArray(i.selections) ? i.selections : [] }));
    const addr = { country: "India", ...(order.shippingAddress || {}) };
    const wa = whatsappLink(settings.whatsappNumber, waMessage({ ...order, items }, addr));
    const orderHref = "order-details.html?id=" + encodeURIComponent(order.id);
    slot.replaceChildren(el("div", { class: "state state--empty", role: "status" },
      el("h2", { class: "state__title", text: "Order submitted — payment verification pending" }),
      el("p", { text: `Your order ${order.orderNumber || ""} has been saved. It will be confirmed only after we verify your payment.` }),
      el("div", { class: "state__actions" }, el("a", { class: "btn btn--primary", href: orderHref, text: "View order" }), el("a", { class: "btn btn--ghost", href: "shop.html", text: "Continue shopping" }))));
    const close = () => { dlg.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const dlg = el("div", { class: "pay-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pm-title" },
      el("div", { class: "pay-modal__card" }, el("h2", { id: "pm-title", text: "Your order has been submitted" }),
        el("p", { text: "Your order has been submitted. Please send your payment screenshot to our WhatsApp so we can verify your payment." }),
        el("p", { class: "summary-note", text: "Attach your payment screenshot in WhatsApp and press Send yourself — the website can't attach it for you. Your order stays in My orders even if you close WhatsApp. Final confirmation depends on our payment verification." }),
        wa ? el("a", { class: "btn btn--caramel btn--block", href: wa, target: "_blank", rel: "noopener noreferrer", text: "Send payment screenshot on WhatsApp" }) : el("p", { class: "line__note", text: "WhatsApp number isn't available right now. Please contact us from the Contact page with your order number." }),
        el("a", { class: "btn btn--primary btn--block", href: orderHref, text: "View my order" }),
        el("button", { type: "button", class: "link-btn", onclick: close }, "Close")));
    document.body.append(dlg); document.addEventListener("keydown", onKey);
    const first = dlg.querySelector("a,button"); if (first) first.focus();
    window.scrollTo({ top: 0 });
  }
  load();
}
if (slot) init();
