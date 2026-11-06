// upi.js — manual "Pay with any UPI App" workflow helpers.
// HOW IT WORKS: the trusted backend creates a pending order; the customer pays in their own UPI app using the deep link built
// here; the customer then sends a payment screenshot to our WhatsApp; an admin verifies it and confirms the order.
// NOTHING here marks an order paid or confirmed. Opening a UPI app, or returning from it, proves nothing — only the admin does.
import { el, formatINR } from "./common.js";

// Merchant configuration lives HERE (not in Firestore). Change these values to change where payments go.
export const PAYMENT_CONFIG = Object.freeze({
  upiId: "kirti07kkapoor@okhdfcbank",
  payeeName: "The Chocolate Story",
  whatsappNumber: "918847050895" // +91 88470 50895, digits only for wa.me
});
export const PAYMENT_METHOD = "upi_manual"; // value stored in orders.paymentMethod by the backend

/** "269" -> "269.00". Returns "" for anything that is not a sensible positive rupee amount. */
export function upiAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000) return "";
  return (Math.round(n * 100) / 100).toFixed(2);
}
/** Builds a UPI deep link (upi://pay?...). On Android this opens the customer's UPI app chooser. */
export function buildUpiLink({ amount, orderNumber, orderId }) {
  const am = upiAmount(amount);
  if (!am) return "";
  const ref = String(orderNumber || orderId || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 35);
  const enc = (v) => encodeURIComponent(v);
  const parts = ["pa=" + enc(PAYMENT_CONFIG.upiId).replace(/%40/g, "@"), "pn=" + enc(PAYMENT_CONFIG.payeeName), "am=" + am, "cu=INR", "tn=" + enc(("Order " + ref).trim().slice(0, 50))];
  if (ref) parts.push("tr=" + enc(ref));
  return "upi://pay?" + parts.join("&");
}

const optText = (it) => (Array.isArray(it.selectedOptions) ? it.selectedOptions : []).map(o => o && (o.name ? o.name + ": " : "") + (o.value || "")).filter(Boolean).join(", ");
/** The prefilled WhatsApp message (the customer attaches the screenshot themselves). */
export function proofMessage(order) {
  const lines = ["Hello! I have placed an order.", "", `Order ID: #${order.orderNumber || order.id}`, `Name: ${order.customerName || ""}`, `Amount: ${formatINR(order.totalAmount)}`, ""];
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length) {
    lines.push("Order details:");
    items.forEach(it => lines.push(`• ${it.name || "Item"}${optText(it) ? " (" + optText(it) + ")" : ""} × ${it.quantity || 1}`));
    if (Number(order.deliveryCharge) > 0) lines.push(`Delivery charge: ${formatINR(order.deliveryCharge)}`);
    lines.push("");
  }
  lines.push("Please verify my payment.", "", "Payment Screenshot: [I will attach it here]");
  return lines.join("\n");
}
export const proofLink = (order) => "https://wa.me/" + PAYMENT_CONFIG.whatsappNumber + "?text=" + encodeURIComponent(proofMessage(order));

/** "Confirm Purchase" popup: explains that proof must be shared on WhatsApp and offers the WhatsApp handoff. */
export function openConfirmPopup(order, opener) {
  const prev = opener || document.activeElement;
  const close = () => { document.removeEventListener("keydown", onKey); scrim.remove(); document.body.classList.remove("no-scroll"); prev && prev.focus && prev.focus(); };
  const wa = el("a", { class: "btn btn--primary btn--block", href: proofLink(order), target: "_blank", rel: "noopener noreferrer", text: "Send Payment Proof via WhatsApp" });
  const closeBtn = el("button", { type: "button", class: "modal__close", "aria-label": "Close", onclick: close }, "×");
  const panel = el("div", { class: "modal__panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "pp-title" }, closeBtn,
    el("h2", { id: "pp-title", class: "modal__title", text: "Payment Submitted?" }),
    el("p", { text: "Please share your payment screenshot and order details on WhatsApp. Your order will be confirmed after admin verification." }),
    el("div", { class: "modal__ur", lang: "ur-Latn" },
      el("h3", { text: "Payment Kar Diya?" }),
      el("p", { text: "Barah-e-karam payment ka screenshot aur order details WhatsApp par bhejein. Admin ki tasdeeq ke baad hi aapka order confirm hoga." })),
    wa);
  const scrim = el("div", { class: "modal", onclick: (e) => { if (e.target === scrim) close(); } }, panel);
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      const f = [...panel.querySelectorAll("a[href],button")]; const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  }
  document.addEventListener("keydown", onKey);
  document.body.append(scrim); document.body.classList.add("no-scroll"); wa.focus();
  return close;
}

/** The payment panel shown for a pending order (right after checkout, and on the order details page). */
export function paymentPanel(order, { heading = "Complete your payment" } = {}) {
  const upi = buildUpiLink({ amount: order.totalAmount, orderNumber: order.orderNumber, orderId: order.id });
  const amountText = formatINR(order.totalAmount);
  const hint = el("p", { class: "paypanel__hint", role: "status", "aria-live": "polite" });
  const confirmBtn = el("button", { type: "button", class: "btn btn--caramel btn--block paypanel__confirm" }, "Confirm Purchase");
  confirmBtn.addEventListener("click", () => openConfirmPopup(order, confirmBtn));
  const payBtn = upi
    ? el("a", { class: "btn btn--primary btn--block", href: upi, text: "Pay with any UPI App" })
    : el("button", { type: "button", class: "btn btn--primary btn--block", disabled: true }, "Pay with any UPI App");
  let launched = false;
  payBtn.addEventListener("click", () => { launched = true; });
  const back = () => { if (launched && document.visibilityState === "visible") { launched = false; hint.textContent = "Welcome back. If you have completed the payment, tap Confirm Purchase."; confirmBtn.classList.add("is-ready"); confirmBtn.focus({ preventScroll: false }); } };
  document.addEventListener("visibilitychange", back);
  return el("section", { class: "paypanel", "aria-label": "Payment" },
    el("h2", { text: heading }),
    el("p", { class: "paypanel__sum" }, el("strong", { text: "Order #" + (order.orderNumber || order.id) }), document.createTextNode(" · Amount to pay: "), el("strong", { text: amountText })),
    el("ol", { class: "paypanel__steps" },
      el("li", { text: `Tap “Pay with any UPI App” and pay exactly ${amountText}.` }),
      el("li", { text: "Come back to this page and tap “Confirm Purchase”." }),
      el("li", { text: "Send your payment screenshot and order details on WhatsApp." })),
    payBtn, confirmBtn, hint,
    el("p", { class: "paypanel__note", text: "Opening a UPI app, or returning from it, does not confirm your order. Your order is confirmed only after our admin verifies your payment. UPI apps open on phones — on a computer, please open this page on your mobile." }));
}
