// checkout.js — review → delivery address → confirm → online payment.
// SECURITY MODEL: the browser never creates orders or payment records and never decides prices. It sends only product IDs,
// quantities, selected options and an address ID to a trusted backend (BACKEND_CONFIG in common.js), which recomputes prices and
// delivery from Firestore, creates the order + Razorpay order, and verifies the payment signature. Until that backend is
// configured, the pay button stays disabled and a support path is offered instead of pretending an order was placed.
import { $, el, formatINR, whatsappLink, getPublicSettings, renderEmpty, renderError, renderLoading, renderInactive, showToast, backendConfigured, callBackend, BackendError } from "./common.js";
import { requireProfile, getUserProfile } from "./auth.js";
import { loadCart, saveCart, resolveCartLines, calculateTotals } from "./cart.js";
import { listAddresses, reconcileDefault, createAddress, buildAddressForm, addressLines } from "./addresses.js";

const slot = $("#checkout-contents");
const ATTEMPT_KEY = "tcs_checkout_attempt";
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = el("script", { src: "https://checkout.razorpay.com/v1/checkout.js", async: true });
    s.onload = resolve; s.onerror = () => reject(new BackendError("We couldn't load the secure payment window. Please check your connection and try again.", 0, "razorpay-load"));
    document.head.append(s);
  });
}
/** Opens Razorpay Checkout; resolves with the payment response or rejects when the customer closes it / it fails. */
function openRazorpay(opts) {
  return new Promise((resolve, reject) => {
    const rz = new window.Razorpay({ ...opts, handler: resolve, modal: { ondismiss: () => reject(new BackendError("Payment window closed before payment was completed.", 0, "dismissed")) } });
    rz.on && rz.on("payment.failed", () => reject(new BackendError("The payment didn't go through. You can try again.", 0, "payment-failed")));
    rz.open();
  });
}

async function init() {
  const ctx = await requireProfile(); if (!ctx) return;
  if (ctx.inactive) return renderInactive(slot);
  const { user, profile } = ctx;
  const settings = await getPublicSettings();
  let views = [], addresses = [], selected = "", adding = false, placing = false, totals = null, noteText = "", agreed = false;
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
    } catch { return renderError(slot, "We couldn't prepare your checkout. Please check your connection and try again.", load); }
    render();
  }
  const blocked = () => views.some(v => v.status === "unavailable");
  const unverified = () => views.some(v => v.status === "unverified");

  function summary(agreeBox, noteBox) {
    const usable = views.filter(v => v.status !== "unavailable");
    totals = calculateTotals(usable.map(v => ({ productId: v.line.productId, name: v.line.name, unitPrice: v.unit, quantity: v.qty, deliveryCharge: v.delivery })));
    const addr = addresses.find(a => a.id === selected);
    const ready = !blocked() && usable.length && addr && agreeBox.checked && !placing;
    const configured = backendConfigured();
    const payBtn = el("button", { type: "button", class: "btn btn--primary btn--block", id: "pay-btn", disabled: !(ready && configured) }, placing ? "Processing…" : `Pay ${formatINR(totals.total)} securely`);
    payBtn.addEventListener("click", () => pay(addr, noteBox.value));
    const wa = whatsappLink(settings.whatsappNumber, "Hello The Chocolate Story! I'd like to place an order:\n" + usable.map(v => `• ${v.line.name}${v.line.selections.length ? " (" + v.line.selections.map(s => s.text || s.label).join(", ") + ")" : ""} × ${v.qty}`).join("\n") + `\nEstimated total: ${formatINR(totals.total)}`);
    return el("aside", { class: "summary-card", "aria-label": "Order summary" }, el("h2", { text: "Order summary" }),
      el("ul", { class: "mini-lines" }, usable.map(v => el("li", { class: "summary-row summary-row--small" }, el("span", { text: `${v.line.name} × ${v.qty}` }), el("span", { text: formatINR(v.unit * v.qty) })))),
      el("div", { class: "summary-row" }, el("span", { text: "Items" }), el("span", { text: formatINR(totals.subtotal) })),
      el("div", { class: "summary-row" }, el("span", { text: "Delivery" }), el("span", { text: formatINR(totals.deliveryTotal) })),
      el("div", { class: "summary-row summary-row--total" }, el("span", { text: unverified() ? "Estimated total" : "Total" }), el("span", { text: formatINR(totals.total) })),
      unverified() ? el("p", { class: "line__note", text: "Some prices couldn't be refreshed. The final amount is confirmed securely before payment." }) : null,
      payBtn,
      configured ? null : el("div", { class: "line__note", role: "status" },
        el("p", { text: "Online payment isn't switched on yet, so we can't take your order on this page just now." }),
        wa ? el("a", { class: "btn btn--caramel btn--block", href: wa, target: "_blank", rel: "noopener noreferrer", text: "Send this order on WhatsApp" }) : null),
      el("p", { class: "summary-note", text: "Online payment only — no Cash on Delivery. Delivery is usually around 6–8 days from the order date (an estimate, not a guarantee)." }),
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

  async function pay(addr, customerNote) {
    if (placing) return; placing = true; render(); live.textContent = "Processing your order…";
    let attempt = sessionStorage.getItem(ATTEMPT_KEY); if (!attempt) { attempt = uuid(); try { sessionStorage.setItem(ATTEMPT_KEY, attempt); } catch { /* ignore */ } }
    const shownPaise = Math.round(totals.total * 100);
    try {
      const created = await callBackend("createOrder", {
        clientRequestId: attempt, addressId: addr.id, customerNote: String(customerNote || "").trim().slice(0, 300),
        items: views.filter(v => v.status !== "unavailable").map(v => ({ productId: v.line.productId, quantity: v.qty, selections: v.line.selections }))
      });
      const rz = created && created.razorpayOrder;
      if (!created || typeof created.orderId !== "string" || !rz || typeof rz.id !== "string" || typeof created.razorpayKeyId !== "string" || !/^rzp_/.test(created.razorpayKeyId) || !Number.isInteger(rz.amount) || rz.amount <= 0)
        throw new BackendError("We received an unexpected response while creating your order. You have not been charged. Please try again.", 0, "bad-response");
      if (rz.amount !== shownPaise && !confirm(`The final total is ${formatINR(rz.amount / 100)} instead of the ${formatINR(totals.total)} shown. Continue to payment?`))
        throw new BackendError("We stopped before payment because the total changed. Your order is saved as pending under My orders; review your cart and try again, or message us for help.", 0, "amount-declined");
      await loadRazorpay();
      const paid = await openRazorpay({ key: created.razorpayKeyId, amount: rz.amount, currency: rz.currency || "INR", name: "The Chocolate Story", description: "Order " + (created.orderNumber || ""), order_id: rz.id,
        prefill: { name: addr.fullName, contact: addr.phone, email: user.email }, theme: { color: "#542E1D" } });
      const verified = await callBackend("verifyPayment", { orderId: created.orderId, razorpayOrderId: paid.razorpay_order_id, razorpayPaymentId: paid.razorpay_payment_id, razorpaySignature: paid.razorpay_signature });
      try { sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* ignore */ }
      if (verified && verified.verified === true) { saveCart([]); return done(created, true); }
      return done(created, false);
    } catch (err) {
      placing = false; render();
      const msg = err instanceof BackendError ? err.message : "Something went wrong. You have not been charged unless your bank tells you otherwise.";
      slot.prepend(el("div", { class: "state state--error", role: "alert" }, el("p", { text: msg }), el("p", { class: "summary-note", text: "If money was deducted, don't pay again — check My orders or message us on WhatsApp." })));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  function done(created, paid) {
    slot.replaceChildren(el("div", { class: "state state--empty", role: "status" },
      el("h2", { class: "state__title", text: paid ? "Payment confirmed — thank you!" : "We're confirming your payment" }),
      el("p", { text: paid ? `Your order ${created.orderNumber || ""} has been placed. You can follow its progress on your orders page.` : "Your payment is being verified. This can take a few minutes — please check your orders page for the latest status before trying again." }),
      el("div", { class: "state__actions" }, el("a", { class: "btn btn--primary", href: "order-details.html?id=" + encodeURIComponent(created.orderId), text: "View order" }), el("a", { class: "btn btn--ghost", href: "shop.html", text: "Continue shopping" }))));
    window.scrollTo({ top: 0 });
  }
  load();
}
if (slot) init();
