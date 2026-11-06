// checkout.js — review → delivery address → place order → pay with any UPI app → confirm purchase on WhatsApp.
// SECURITY MODEL: the browser never creates orders and never decides prices. It sends only product IDs, quantities, selected
// options and an address ID to the trusted backend (Cloud Function, see /functions), which recomputes every price from Firestore and
// creates the order as status "pending" / payment "pending" using the Admin SDK. Payment is made by the customer in their own UPI app;
// an admin verifies it manually and confirms the order. Nothing on this page ever marks an order paid or confirmed.
import { $, el, formatINR, whatsappLink, getPublicSettings, renderEmpty, renderError, renderLoading, renderInactive, backendConfigured, callBackend, BackendError } from "./common.js";
import { paymentPanel } from "./upi.js";
import { requireProfile, getUserProfile } from "./auth.js";
import { loadCart, saveCart, resolveCartLines, calculateTotals } from "./cart.js";
import { listAddresses, reconcileDefault, createAddress, buildAddressForm, addressLines } from "./addresses.js";

const slot = $("#checkout-contents");
const ATTEMPT_KEY = "tcs_checkout_attempt";
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

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
    const configured = backendConfigured("createOrder");
    const payBtn = el("button", { type: "button", class: "btn btn--primary btn--block", id: "pay-btn", disabled: !(ready && configured) }, placing ? "Placing your order…" : `Place order · ${formatINR(totals.total)}`);
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
        el("p", { text: "Online ordering isn't switched on yet, so we can't take your order on this page just now." }),
        wa ? el("a", { class: "btn btn--caramel btn--block", href: wa, target: "_blank", rel: "noopener noreferrer", text: "Send this order on WhatsApp" }) : null),
      configured ? el("p", { class: "summary-note", text: "Next step: pay with any UPI app. Your order is confirmed only after our admin verifies your payment." }) : null,
      el("p", { class: "summary-note", text: "Payment by UPI only — no Cash on Delivery. Delivery is usually around 6–8 days from the order date (an estimate, not a guarantee)." }),
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
    if (placing) return; placing = true; render(); live.textContent = "Placing your order…";
    let attempt = sessionStorage.getItem(ATTEMPT_KEY); if (!attempt) { attempt = uuid(); try { sessionStorage.setItem(ATTEMPT_KEY, attempt); } catch { /* ignore */ } }
    const shownPaise = Math.round(totals.total * 100);
    try {
      const created = await callBackend("createOrder", {
        clientRequestId: attempt, addressId: addr.id, customerNote: String(customerNote || "").trim().slice(0, 300),
        items: views.filter(v => v.status !== "unavailable").map(v => ({ productId: v.line.productId, quantity: v.qty, selections: v.line.selections }))
      });
      const o = created && created.order;
      if (!o || typeof o.id !== "string" || typeof o.orderNumber !== "string" || !Number.isFinite(Number(o.totalAmount)) || Number(o.totalAmount) <= 0)
        throw new BackendError("We received an unexpected response while placing your order. Please check My orders before trying again.", 0, "bad-response");
      try { sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* ignore */ }
      saveCart([]); // the order now exists (pending payment), so the cart is emptied
      done(o, Math.round(Number(o.totalAmount) * 100) !== shownPaise ? `The final total is ${formatINR(o.totalAmount)}, not the ${formatINR(totals.total)} shown earlier, because a price or delivery charge was updated. Please pay the amount below.` : "");
    } catch (err) {
      placing = false; render();
      const msg = err instanceof BackendError ? err.message : "Something went wrong while placing your order.";
      slot.prepend(el("div", { class: "state state--error", role: "alert" }, el("p", { text: msg }), el("p", { class: "summary-note", text: "No payment has been taken. If you think an order was created, check My orders before trying again." })));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  function done(o, mismatchNote) {
    slot.replaceChildren(el("div", { class: "checkout-done" },
      el("div", { class: "state state--empty", role: "status" },
        el("h2", { class: "state__title", text: "Order placed — payment pending" }),
        el("p", { text: `Your order #${o.orderNumber} has been saved. It will be confirmed after we verify your payment.` })),
      mismatchNote ? el("p", { class: "line__note", role: "alert", text: mismatchNote }) : null,
      paymentPanel(o),
      el("div", { class: "state__actions" }, el("a", { class: "btn btn--ghost", href: "order-details.html?id=" + encodeURIComponent(o.id), text: "View order" }), el("a", { class: "btn btn--ghost", href: "shop.html", text: "Continue shopping" }))));
    window.scrollTo({ top: 0 });
  }
  load();
}
if (slot) init();
