// orders.js — orders list (orders.html) and order details (order-details.html?id=…).
// Customers can read their own orders (live) and may only file a cancellation REQUEST before shipping; only the admin changes status.
import { db, collection, doc, getDoc, getDocs, query, where, limit, updateDoc, serverTimestamp, onSnapshot } from "./firebase.js";
import { $, el, formatINR, formatDate, toDate, safeUrl, num, whatsappLink, getPublicSettings, renderEmpty, renderError, renderLoading, renderInactive, showToast } from "./common.js";
import { requireProfile } from "./auth.js";
import { addressLines } from "./addresses.js";

const STATUS = { pending: "Pending Payment Verification", pending_payment_verification: "Pending Payment Verification", confirmed: "Confirmed", processing: "Processing", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled", canceled: "Cancelled" };
const PAYMENT = { pending: "Payment pending", pending_verification: "Payment pending verification", verified: "Payment verified", paid: "Paid", failed: "Payment failed", refunded: "Refunded", partially_refunded: "Partially refunded" };
const label = (map, v) => map[String(v || "").toLowerCase()] || (v ? String(v).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "—");
const STEPS = ["pending_payment_verification", "confirmed", "processing", "shipped", "delivered"];
const STEP_TIME = { pending_payment_verification: "createdAt", confirmed: "confirmedAt", processing: "processingAt", shipped: "shippedAt", delivered: "deliveredAt" };
const stepIndex = (s) => STEPS.indexOf(s === "pending" ? "pending_payment_verification" : s);
const CANCELLABLE = ["pending", "pending_payment_verification", "confirmed", "processing"];
const idOk = (s) => /^[A-Za-z0-9_-]{1,128}$/.test(s || "");
const millis = (v) => toDate(v)?.getTime() || 0;
const total = (o) => num(o.totalAmount ?? o.total ?? o.grandTotal, NaN);

/* ---------- list ---------- */
async function initList(slot) {
  const ctx = await requireProfile(); if (!ctx) return;
  if (ctx.inactive) return renderInactive(slot);
  const run = async () => {
    renderLoading(slot, "Loading your orders…");
    let orders;
    try { orders = (await getDocs(query(collection(db, "orders"), where("userId", "==", ctx.user.uid), limit(60)))).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => millis(b.createdAt) - millis(a.createdAt)); }
    catch { return renderError(slot, "We couldn't load your orders. Please check your connection and try again.", run); }
    if (!orders.length) return renderEmpty(slot, { title: "No orders yet", text: "When you place an order, you'll be able to follow it here.", actionText: "Start shopping", actionHref: "shop.html" });
    slot.replaceChildren(el("ul", { class: "order-list" }, orders.map(o => {
      const t = total(o), n = Array.isArray(o.items) ? o.items.reduce((s, i) => s + (num(i && i.quantity, 1)), 0) : 0;
      return el("li", { class: "order-card" },
        el("div", { class: "order-card__top" }, el("strong", { text: o.orderNumber ? "Order " + o.orderNumber : "Order" }), el("span", { class: "status-pill status-pill--" + String(o.status || "").toLowerCase(), text: label(STATUS, o.status) })),
        el("p", { class: "order-card__meta" }, [formatDate(o.createdAt), n ? `${n} item${n === 1 ? "" : "s"}` : "", Number.isFinite(t) ? formatINR(t) : "", label(PAYMENT, o.paymentStatus)].filter(Boolean).join(" · ")),
        el("a", { class: "btn btn--ghost", href: "order-details.html?id=" + encodeURIComponent(o.id), text: "View details" }));
    })));
  };
  run();
}

/* ---------- details ---------- */
const progress = (o) => {
  const s = String(o.status || "").toLowerCase();
  if (s === "cancelled" || s === "canceled") return el("p", { class: "status-banner status-banner--off", role: "status", text: "This order was cancelled." });
  const at = stepIndex(s);
  return el("ol", { class: "steps", "aria-label": "Order progress" }, STEPS.map((k, i) => {
    const when = i <= at ? formatDate(o[STEP_TIME[k]], true) : "";   // only real, admin-recorded times
    return el("li", { class: i < at ? "is-done" : i === at ? "is-now" : "", "aria-current": i === at ? "step" : null }, el("span", { class: "steps__dot", "aria-hidden": "true" }), el("span", { text: label(STATUS, k) }), when ? el("small", { text: when }) : null);
  }));
};
function itemRow(i) {
  const name = String((i && (i.name || i.productName)) || "Item").slice(0, 160), q = num(i && i.quantity, 1);
  const unit = num(i && (i.unitPrice ?? i.price), NaN), line = num(i && (i.lineTotal ?? i.total), Number.isFinite(unit) ? unit * q : NaN);
  const sel = Array.isArray(i && (i.selections || i.options)) ? (i.selections || i.options).map(s => s && (typeof s === "string" ? s : `${s.group || s.name || ""}${s.group || s.name ? ": " : ""}${s.text || s.label || s.value || ""}`)).filter(Boolean) : [];
  return el("li", { class: "oi" }, el("div", {}, el("strong", { text: name }), sel.length ? el("ul", { class: "line__opts" }, sel.map(t => el("li", { text: String(t).slice(0, 160) }))) : null, el("span", { class: "summary-note", text: `Qty ${q}` })),
    el("span", { text: Number.isFinite(line) ? formatINR(line) : "" }));
}
function shipmentBlock(sh) {
  if (!sh) return el("p", { class: "summary-note", text: "No shipment has been created yet. Tracking details will appear here once your order ships." });
  const st = String(sh.status || "").toLowerCase();
  const shipped = ["shipped", "in_transit", "out_for_delivery", "delivered"].includes(st), delivered = st === "delivered";
  const url = safeUrl(sh.trackingURL || sh.trackingUrl);
  const est = formatDate(sh.estimatedDeliveryDate);
  const rows = [
    ["Shipment status", label({ pending: "Preparing to ship", processing: "Preparing to ship", shipped: "Shipped", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered" }, st)],
    sh.courierName ? ["Courier", String(sh.courierName).slice(0, 80)] : null,
    sh.trackingNumber ? ["Tracking number", String(sh.trackingNumber).slice(0, 80)] : null,
    shipped && formatDate(sh.shippedAt) ? ["Shipped on", formatDate(sh.shippedAt)] : null,
    est && !delivered ? ["Estimated delivery", est] : null,
    delivered && formatDate(sh.deliveredAt) ? ["Delivered on", formatDate(sh.deliveredAt)] : null,
    sh.delayReason ? ["Update", String(sh.delayReason).slice(0, 240)] : null
  ].filter(Boolean);
  return el("div", {}, el("dl", { class: "kv" }, rows.map(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])), url ? el("a", { class: "btn btn--ghost", href: url, target: "_blank", rel: "noopener noreferrer", text: "Track shipment" }) : null);
}

async function initDetails(slot) {
  const ctx = await requireProfile(); if (!ctx) return;
  if (ctx.inactive) return renderInactive(slot);
  const { user } = ctx, id = new URLSearchParams(location.search).get("id");
  const settings = await getPublicSettings();
  if (!idOk(id)) return renderEmpty(slot, { title: "Choose an order", text: "Open an order from your orders list.", actionText: "My orders", actionHref: "orders.html" });
  const run = async () => {
    renderLoading(slot, "Loading your order…");
    let o, shipment = null, txn = null;
    try {
      const s = await getDoc(doc(db, "orders", id));
      o = s.exists() ? { id: s.id, ...s.data() } : null;
    } catch (err) { if (err && err.code === "permission-denied") o = null; else return renderError(slot, "We couldn't load this order. Please check your connection and try again.", run); }
    if (!o || o.userId !== user.uid) return renderEmpty(slot, { title: "We couldn't find that order", text: "It may belong to a different account, or the link may be incorrect.", actionText: "My orders", actionHref: "orders.html" });
    try {
      const [sh, tx] = await Promise.all([
        getDocs(query(collection(db, "shipments"), where("orderId", "==", id), where("userId", "==", user.uid), limit(5))),
        getDocs(query(collection(db, "paymentTransactions"), where("orderId", "==", id), where("userId", "==", user.uid), limit(5)))]);
      shipment = sh.docs.map(d => d.data()).sort((a, b) => millis(b.updatedAt || b.createdAt) - millis(a.updatedAt || a.createdAt))[0] || null;
      txn = tx.docs.map(d => d.data()).sort((a, b) => millis(b.createdAt) - millis(a.createdAt))[0] || null;
    } catch { /* shipment/payment extras are optional; the order itself still renders */ }
    render(o, shipment, txn);
    if (!unsub) unsub = onSnapshot(doc(db, "orders", id), (s2) => { if (s2.exists() && s2.data().userId === user.uid && !s2.metadata.hasPendingWrites) { const n = { id: s2.id, ...s2.data() }; if (JSON.stringify([n.status, n.paymentStatus, n.updatedAt && n.updatedAt.seconds]) !== JSON.stringify([o.status, o.paymentStatus, o.updatedAt && o.updatedAt.seconds])) { o = n; render(o, shipment, txn); } } }, () => { /* stay on the last rendered state */ });
  };
  let unsub = null;
  function render(o, shipment, txn) {
    const st = String(o.status || "").toLowerCase(), items = Array.isArray(o.items) ? o.items : [];
    const t = total(o), sub = num(o.subtotal, NaN), dc = num(o.deliveryCharge ?? o.deliveryTotal, NaN);
    const wa = whatsappLink(settings.whatsappNumber, `Hello The Chocolate Story! I need help with order ${o.orderNumber || o.id}.`);
    const live = el("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    const created = toDate(o.createdAt), est = created && st !== "delivered" && st !== "cancelled" && st !== "canceled" ? `${formatDate(new Date(created.getTime() + 6 * 864e5))} – ${formatDate(new Date(created.getTime() + 8 * 864e5))}` : "";
    let cancelBlock = null;
    const cr = o.cancellationRequest && typeof o.cancellationRequest === "object" ? o.cancellationRequest : null, crs = cr ? String(cr.status || "") : "";
    if (cr && crs === "requested") cancelBlock = el("section", { class: "panel" }, el("h2", { text: "Cancellation requested" }), el("p", { text: `You asked to cancel this order${formatDate(cr.requestedAt, true) ? " on " + formatDate(cr.requestedAt, true) : ""}. Our team will review it; your order stays active until we confirm.` }), cr.reason ? el("p", { class: "summary-note", text: "Your reason: " + String(cr.reason).slice(0, 300) }) : null);
    else if (cr && crs === "declined") cancelBlock = el("section", { class: "panel" }, el("h2", { text: "Cancellation request declined" }), el("p", { text: "Our team reviewed your cancellation request and couldn't cancel this order. Please message us on WhatsApp if you need help." }), wa ? el("a", { class: "btn btn--caramel", href: wa, target: "_blank", rel: "noopener noreferrer", text: "Message us on WhatsApp" }) : null);
    else if (cr && crs === "accepted") cancelBlock = el("p", { class: "summary-note", text: "Your cancellation request was accepted." });
    else if (CANCELLABLE.includes(st)) {
      const reason = el("textarea", { id: "cancel-reason", rows: 2, maxlength: 300, placeholder: "Reason (optional)", "aria-label": "Cancellation reason (optional)" });
      const btn = el("button", { type: "button", class: "btn btn--ghost" }, "Request cancellation");
      btn.addEventListener("click", async () => {
        if (!confirm("Request cancellation of this order? Our team will review it. This can only be requested before the order ships.")) return;
        btn.disabled = true; live.textContent = "Sending your cancellation request…";
        try {
          await updateDoc(doc(db, "orders", o.id), { cancellationRequest: { status: "requested", requestedAt: serverTimestamp(), reason: reason.value.trim().slice(0, 300) }, updatedAt: serverTimestamp() });
          showToast("Your cancellation request was sent.", { type: "success" });
        } catch (err) { btn.disabled = false; showToast(err && err.code === "permission-denied" ? "This order can no longer be cancelled — it may have just shipped. Please reload." : "We couldn't send your request. Please try again.", { type: "error" }); }
      });
      cancelBlock = el("section", { class: "panel" }, el("h2", { text: "Need to cancel?" }),
        el("p", { text: "You can request cancellation until your order ships. Only our team can cancel the order after reviewing your request; refunds are handled by our team." }), reason, btn);
    } else if (["shipped", "delivered"].includes(st)) {
      cancelBlock = el("p", { class: "summary-note", text: "Cancellation can no longer be requested because this order has shipped. If something is wrong with your delivery, message us on WhatsApp with photos." });
    }
    slot.replaceChildren(el("div", { class: "order-detail" },
      el("section", { class: "panel" }, el("div", { class: "order-card__top" }, el("h2", { text: o.orderNumber ? "Order " + o.orderNumber : "Your order" }), el("span", { class: "status-pill status-pill--" + st, text: label(STATUS, o.status) })),
        el("p", { class: "order-card__meta", text: [formatDate(o.createdAt, true), "Payment: " + (o.paymentMethod === "UPI" ? "UPI" : "Online payment"), label(PAYMENT, o.paymentStatus)].filter(Boolean).join(" · ") }),
        progress(o),
        el("p", { class: "summary-note", text: est ? `Estimated delivery period (an estimate, not a delivery status): ${est}. Your order moves to Shipped and Delivered only when our team updates it.` : "Delivery is usually around 6–8 days from the order date. This is an estimate, not a guaranteed date." }),
        st === "pending_payment_verification" || st === "pending" ? el("p", { class: "line__note", text: "We're waiting to verify your payment. If you haven't yet, please send your UPI payment screenshot to us on WhatsApp." }) : null),
      el("section", { class: "panel" }, el("h2", { text: "Items" }), items.length ? el("ul", { class: "oi-list" }, items.map(itemRow)) : el("p", { class: "summary-note", text: "Item details aren't available for this order." }),
        el("div", { class: "summary-row" }, el("span", { text: "Items" }), el("span", { text: Number.isFinite(sub) ? formatINR(sub) : "—" })),
        el("div", { class: "summary-row" }, el("span", { text: "Delivery" }), el("span", { text: Number.isFinite(dc) ? formatINR(dc) : "—" })),
        el("div", { class: "summary-row summary-row--total" }, el("span", { text: "Total" }), el("span", { text: Number.isFinite(t) ? formatINR(t) : "—" })),
        txn ? el("p", { class: "summary-note", text: "Payment record: " + label({ created: "Started", paid: "Paid", captured: "Paid", failed: "Failed", refunded: "Refunded" }, txn.status) }) : null),
      o.shippingAddress && typeof o.shippingAddress === "object" ? el("section", { class: "panel" }, el("h2", { text: "Delivering to" }), el("address", { class: "addr-lines" }, addressLines({ country: "India", ...o.shippingAddress }).map((l, i) => el(i === 0 ? "strong" : "span", { text: l })))) : null,
      el("section", { class: "panel" }, el("h2", { text: "Shipment" }), shipmentBlock(shipment)),
      cancelBlock,
      st === "delivered" ? el("p", {}, el("a", { class: "btn btn--primary", href: "reviews.html", text: "Write a review" })) : null,
      el("p", {}, el("a", { class: "link-btn", href: "orders.html", text: "← All orders" })), live));
  }
  run();
}

const page = document.body.dataset.page, slot = $("#orders-contents");
if (slot) (page === "order-details" ? initDetails : initList)(slot);
