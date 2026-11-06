// app.js — the HTTP handler. Dependencies are injected (see index.js) so it can be tested without Firebase.
"use strict";
const { OrderError, ID_RE, parseCreateBody, buildItems, orderNumber, istYear, canCustomerCancel } = require("./order-logic");

function makeApp({ db, verifyIdToken, serverTimestamp, allowedOrigins, now = () => new Date(), log = console }) {
  const allowed = new Set(allowedOrigins);

  function cors(req, res) {
    const origin = req.headers.origin;
    res.set("Vary", "Origin");
    if (origin && allowed.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Max-Age", "3600");
    }
  }
  const send = (res, status, body) => { res.status(status).set("Cache-Control", "no-store").json(body); };

  /** Verifies the Firebase ID token. Customers must be Google, email-verified users (same rule as firestore.rules). */
  async function authenticate(req) {
    const h = String(req.headers.authorization || "");
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw new OrderError(401, "unauthenticated", "Please sign in again.");
    let decoded;
    try { decoded = await verifyIdToken(m[1]); } catch { throw new OrderError(401, "unauthenticated", "Please sign in again."); }
    if (decoded.email_verified !== true || !decoded.firebase || decoded.firebase.sign_in_provider !== "google.com") throw new OrderError(403, "forbidden", "Please sign in with a verified Google account.");
    return decoded;
  }

  const publicOrder = (id, o) => ({ id, orderNumber: o.orderNumber, customerName: o.customerName, customerEmail: o.customerEmail, items: o.items, subtotal: o.subtotal, deliveryCharge: o.deliveryCharge, totalAmount: o.totalAmount, currency: o.currency, status: o.status, paymentStatus: o.paymentStatus, paymentMethod: o.paymentMethod });

  async function createOrder(user, body) {
    const req = parseCreateBody(body);
    const uid = user.uid;
    const profileSnap = await db.collection("users").doc(uid).get();
    if (!profileSnap.exists || profileSnap.data().isActive === false) throw new OrderError(403, "inactive", "Your account can't place orders. Please contact us.");
    const profile = profileSnap.data();
    const addrSnap = await db.collection("users").doc(uid).collection("addresses").doc(req.addressId).get();
    if (!addrSnap.exists) throw new OrderError(404, "address-not-found", "Please choose a saved delivery address.");
    const a = addrSnap.data();
    for (const k of ["fullName", "phone", "addressLine1", "city", "state", "pincode"]) if (typeof a[k] !== "string" || !a[k].trim()) throw new OrderError(409, "address-incomplete", "Your delivery address is incomplete. Please edit it and try again.");
    const shippingAddress = { fullName: a.fullName, phone: a.phone, addressLine1: a.addressLine1, addressLine2: a.addressLine2 || "", landmark: a.landmark || "", city: a.city, state: a.state, pincode: a.pincode, country: a.country || "India" };

    const ids = [...new Set(req.lines.map((l) => l.productId))];
    const snaps = await db.getAll(...ids.map((id) => db.collection("products").doc(id)));
    const products = new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
    const built = buildItems(req.lines, products);

    const base = {
      userId: uid,
      customerName: String(profile.displayName || user.name || a.fullName || "").slice(0, 120),
      customerEmail: user.email || profile.email || "",
      customerPhone: String(profile.phoneNumber || a.phone || ""),
      shippingAddress, items: built.items, subtotal: built.subtotal, deliveryCharge: built.deliveryCharge, totalAmount: built.totalAmount,
      currency: "INR", paymentMethod: "upi_manual", paymentStatus: "pending", status: "pending", customerNote: req.customerNote
    };
    const year = istYear(now());
    const orderRef = db.collection("orders").doc();
    const result = await db.runTransaction(async (t) => {
      // 1) idempotency: the same checkout attempt never creates a second order
      const dup = await t.get(db.collection("orders").where("userId", "==", uid).where("clientRequestId", "==", req.clientRequestId).limit(1));
      if (!dup.empty) return { id: dup.docs[0].id, data: dup.docs[0].data() };
      // 2) sequential, human-friendly order number (TCS-2026-0001, ...)
      const counterRef = db.collection("counters").doc("orders-" + year);
      const c = await t.get(counterRef);
      const seq = (c.exists && Number.isInteger(c.data().last) ? c.data().last : 0) + 1;
      const data = { ...base, orderNumber: orderNumber(year, seq), clientRequestId: req.clientRequestId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
      t.set(counterRef, { last: seq, updatedAt: serverTimestamp() }, { merge: true });
      t.set(orderRef, data);
      return { id: orderRef.id, data };
    });
    return { order: publicOrder(result.id, result.data) };
  }

  async function cancelOrder(user, body) {
    const id = body && body.orderId;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new OrderError(400, "bad-request", "Invalid order.");
    const ref = db.collection("orders").doc(id);
    return db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || s.data().userId !== user.uid) throw new OrderError(404, "not-found", "We couldn't find that order.");
      const status = String(s.data().status || "").toLowerCase();
      if (status === "cancelled") return { ok: true, status: "cancelled" };
      if (!canCustomerCancel(status)) throw new OrderError(409, "not-cancellable", "This order can't be cancelled because it has already been shipped.");
      t.update(ref, { status: "cancelled", updatedAt: serverTimestamp() });
      return { ok: true, status: "cancelled" };
    });
  }

  const routes = { "/checkout/create-order": createOrder, "/orders/cancel": cancelOrder };

  return async function handler(req, res) {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return send(res, 405, { error: { code: "method-not-allowed", message: "Method not allowed." } });
    const route = routes[String(req.path || "").replace(/\/+$/, "")];
    if (!route) return send(res, 404, { error: { code: "not-found", message: "Not found." } });
    try {
      const user = await authenticate(req);
      return send(res, 200, await route(user, req.body));
    } catch (err) {
      if (err instanceof OrderError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      log.error("order backend error:", err && err.code ? err.code : "", err && err.message ? String(err.message).slice(0, 200) : ""); // never log request bodies / personal data
      return send(res, 500, { error: { code: "internal", message: "Something went wrong on our side. Please try again." } });
    }
  };
}
module.exports = { makeApp };
