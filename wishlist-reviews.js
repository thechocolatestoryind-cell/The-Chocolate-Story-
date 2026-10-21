// wishlist-reviews.js — wishlist (Stage 3) and the reviews page (Stage 4).
// Wishlist doc: wishlists/{uid} = { userId, productIds[], createdAt, updatedAt } — exactly the fields firestore.rules allow.
import { db, collection, doc, getDoc, getDocs, query, where, limit, setDoc, updateDoc, serverTimestamp, arrayUnion, arrayRemove } from "./firebase.js";
import { $, el, showToast, renderEmpty, renderError, renderLoading, productCard, setWishState, formatDate, backendConfigured, callBackend, BackendError } from "./common.js";
import { authReady, isGoogleUser, requireAuth, safeNext } from "./auth.js";


export const WISHLIST_LIMIT = 100; // enforced by the rules

/**
 * Wishlist controller shared by shop, product and wishlist pages.
 * Reads use a `userId ==` query (a plain get on a missing doc is denied by the rules).
 */
export async function createWishlistController() {
  const user = await authReady();
  const signedIn = isGoogleUser(user);
  const ids = new Set();
  let docId = null, loadFailed = false;
  if (signedIn) {
    try {
      const snap = await getDocs(query(collection(db, "wishlists"), where("userId", "==", user.uid), limit(1)));
      if (!snap.empty) {
        docId = snap.docs[0].id;
        const list = snap.docs[0].data().productIds;
        (Array.isArray(list) ? list : []).forEach(x => { if (typeof x === "string" && x) ids.add(x); });
      }
    } catch { loadFailed = true; }
  }
  const loginRedirect = () => {
    const here = (location.pathname.split("/").pop() || "index.html") + location.search;
    location.href = "login.html?next=" + encodeURIComponent(safeNext(here));
  };
  async function add(id) {
    if (ids.size >= WISHLIST_LIMIT) throw new Error("limit");
    if (!docId) {
      await setDoc(doc(db, "wishlists", user.uid), { userId: user.uid, productIds: [id], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      docId = user.uid;
    } else {
      await updateDoc(doc(db, "wishlists", docId), { productIds: arrayUnion(id), updatedAt: serverTimestamp() });
    }
    ids.add(id);
  }
  async function remove(id) {
    if (!docId) { ids.delete(id); return; }
    await updateDoc(doc(db, "wishlists", docId), { productIds: arrayRemove(id), updatedAt: serverTimestamp() });
    ids.delete(id);
  }
  return {
    signedIn, loadFailed,
    has: (id) => ids.has(id),
    all: () => [...ids],
    remove,
    /** Toggles; resolves to the new saved state, or null if the customer was sent to sign in. */
    async toggle(id) {
      if (!signedIn) { loginRedirect(); return null; }
      if (loadFailed) { showToast("We couldn't reach your wishlist. Please try again shortly.", { type: "error" }); return ids.has(id); }
      try { if (ids.has(id)) { await remove(id); return false; } await add(id); return true; }
      catch (err) {
        showToast(err && err.message === "limit" ? "Your wishlist is full (100 items). Remove something to add more." : "Couldn't update your wishlist. Please try again.", { type: "error" });
        return ids.has(id);
      }
    }
  };
}

/** Handler for heart buttons on product cards. */
export function wishHandler(ctl) {
  return async (p, btn) => {
    btn.disabled = true;
    const state = await ctl.toggle(p.id);
    btn.disabled = false;
    if (state === null) return;
    setWishState(btn, state);
    showToast(state ? "Saved to your wishlist." : "Removed from your wishlist.", { type: "success", timeout: 2500 });
  };
}

/* ---------- wishlist page ---------- */
async function initWishlist() {
  const slot = $("#wishlist-contents");
  if (!(await requireAuth())) return;
  const run = async () => {
    renderLoading(slot, "Loading your wishlist…");
    const ctl = await createWishlistController();
    if (ctl.loadFailed) return renderError(slot, "We couldn't load your wishlist. Please try again.", run);
    const ids = ctl.all();
    if (!ids.length) return renderEmpty(slot, { title: "Your wishlist is empty", text: "Tap the heart on any product to save it here.", image: "empty-wishlist.png", actionText: "Browse the shop", actionHref: "shop.html" });
    const results = await Promise.all(ids.map(async id => {
      try { const s = await getDoc(doc(db, "products", id)); return s.exists() ? { id, p: { id: s.id, ...s.data() } } : { id, p: null }; }
      catch (err) { return { id, p: null, denied: err && err.code === "permission-denied" }; }
    }));
    const grid = el("ul", { class: "p-grid" });
    const gone = el("ul", { class: "gone-list" });
    const handler = async (p, btn) => {
      btn.disabled = true;
      try { await ctl.remove(p.id); btn.closest("li").remove(); showToast("Removed from your wishlist.", { type: "success", timeout: 2500 }); if (!grid.children.length && !gone.children.length) run(); }
      catch { btn.disabled = false; showToast("Couldn't update your wishlist. Please try again.", { type: "error" }); }
    };
    results.forEach(r => {
      if (r.p) grid.append(productCard(r.p, { saved: true, onWish: handler }));
      else gone.append(el("li", { class: "gone" }, el("span", { text: "A saved item is no longer available." }),
        el("button", { type: "button", class: "link-btn", onclick: async (e) => { try { await ctl.remove(r.id); e.target.closest("li").remove(); } catch { showToast("Couldn't remove it. Please try again.", { type: "error" }); } } }, "Remove")));
    });
    slot.replaceChildren(...[grid, gone.children.length ? el("div", { class: "gone-wrap" }, el("h2", { text: "No longer available" }), gone) : null].filter(Boolean));
  };
  run();
}

/* ---------- reviews page ---------- */
// Reviews can be READ here (approved ones, plus your own). Submitting needs the trusted backend (BACKEND_CONFIG): the rules forbid
// customers from creating review documents, and the backend must verify the order is theirs, delivered, and contains the product.
const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
const clampRating = (v) => Math.min(5, Math.max(0, Math.round(Number(v) || 0)));
const ms = (v) => (v && typeof v.toMillis === "function") ? v.toMillis() : 0;
function reviewCard(r, { mine = false } = {}) {
  const n = clampRating(r.rating);
  return el("li", { class: "rev rev--full" },
    el("p", { class: "rev__stars", role: "img", "aria-label": `Rated ${n} out of 5` }, stars(n)),
    el("blockquote", { class: "rev__text" }, el("p", { text: String(r.reviewText || "").slice(0, 1000) })),
    el("p", { class: "rev__meta", text: [mine ? (r.isApproved === true ? "Your review" : "Your review — awaiting approval") : "", r.isVerifiedPurchase === true ? "Verified purchase" : "", formatDate(r.createdAt)].filter(Boolean).join(" · ") }));
}
async function initReviews(slot) {
  renderLoading(slot, "Loading reviews…");
  let approved;
  try {
    approved = (await getDocs(query(collection(db, "reviews"), where("isApproved", "==", true), limit(60)))).docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(r => typeof r.reviewText === "string" && r.reviewText.trim()).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  } catch { return renderError(slot, "We couldn't load reviews right now. Please check your connection and try again.", () => initReviews(slot)); }
  const user = await authReady(), signedIn = isGoogleUser(user);
  let mine = [];
  if (signedIn) { try { mine = (await getDocs(query(collection(db, "reviews"), where("userId", "==", user.uid), limit(30)))).docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.isApproved !== true).sort((a, b) => ms(b.createdAt) - ms(a.createdAt)); } catch { /* optional */ } }

  const avg = approved.length ? approved.reduce((s, r) => s + clampRating(r.rating), 0) / approved.length : 0;
  const summary = approved.length ? el("div", { class: "rev-summary" }, el("strong", { class: "rev-summary__n", text: avg.toFixed(1) }), el("div", {}, el("p", { class: "rev__stars", role: "img", "aria-label": `Average rating ${avg.toFixed(1)} out of 5` }, stars(Math.round(avg))), el("p", { class: "summary-note", text: `Based on ${approved.length} approved review${approved.length === 1 ? "" : "s"}` }))) : null;

  const writeBox = el("section", { class: "panel" }, el("h2", { text: "Write a review" }));
  if (!signedIn) writeBox.append(el("p", { text: "Sign in to review products from your delivered orders." }), el("a", { class: "btn btn--primary", href: "login.html?next=reviews.html", text: "Sign in" }));
  else if (!backendConfigured()) writeBox.append(el("p", { text: "Review submission isn't switched on yet. Reviews need a secure check that the order is yours and delivered, so this will open once our order service is live." }));
  else {
    writeBox.append(el("p", { class: "summary-note", text: "Loading your delivered orders…" }));
    (async () => {
      let orders = [];
      try { orders = (await getDocs(query(collection(db, "orders"), where("userId", "==", user.uid), limit(60)))).docs.map(d => ({ id: d.id, ...d.data() })).filter(o => String(o.status).toLowerCase() === "delivered" && Array.isArray(o.items) && o.items.some(i => i && typeof i.productId === "string")); }
      catch { writeBox.replaceChildren(el("h2", { text: "Write a review" }), el("p", { text: "We couldn't load your orders. Please try again later." })); return; }
      if (!orders.length) { writeBox.replaceChildren(el("h2", { text: "Write a review" }), el("p", { text: "Once an order is delivered, you can review its products here." })); return; }
      const orderSel = el("select", { id: "rv-order" }, orders.map(o => el("option", { value: o.id, text: `Order ${o.orderNumber || o.id.slice(0, 6)}` })));
      const prodSel = el("select", { id: "rv-prod" });
      const fill = () => { const o = orders.find(x => x.id === orderSel.value); prodSel.replaceChildren(...o.items.filter(i => i && typeof i.productId === "string").map(i => el("option", { value: i.productId, text: String(i.name || i.productName || "Product").slice(0, 80) }))); };
      orderSel.addEventListener("change", fill); fill();
      const text = el("textarea", { id: "rv-text", rows: 4, maxlength: 1000, placeholder: "Tell others what you thought (max 1000 characters)" });
      const rate = el("fieldset", { class: "rate" }, el("legend", { text: "Your rating" }), [1, 2, 3, 4, 5].map(n => el("span", { class: "rate__opt" }, el("input", { type: "radio", name: "rating", id: "rt" + n, value: String(n) }), el("label", { for: "rt" + n, "aria-label": `${n} star${n > 1 ? "s" : ""}`, text: `${n} ★` }))));
      const status = el("p", { class: "form-status", role: "status" });
      const btn = el("button", { type: "submit", class: "btn btn--primary", text: "Submit review" });
      const form = el("form", { novalidate: true }, el("div", { class: "form-grid" }, el("div", { class: "field" }, el("label", { for: "rv-order", text: "Order" }), orderSel), el("div", { class: "field" }, el("label", { for: "rv-prod", text: "Product" }), prodSel)), rate,
        el("div", { class: "field field--wide" }, el("label", { for: "rv-text", text: "Your review" }), text), status, el("div", { class: "form-actions" }, btn));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const rating = Number((form.querySelector('input[name="rating"]:checked') || {}).value), body = text.value.trim();
        if (!(rating >= 1 && rating <= 5)) { status.textContent = "Please choose a star rating."; return; }
        if (body.length < 5) { status.textContent = "Please write a few words about the product."; text.focus(); return; }
        btn.disabled = true; status.textContent = "Submitting…";
        try {
          await callBackend("submitReview", { orderId: orderSel.value, productId: prodSel.value, rating, reviewText: body });
          form.replaceChildren(el("p", { role: "status", text: "Thank you! Your review was received and will appear after it has been checked." }));
        } catch (err) { btn.disabled = false; status.textContent = err instanceof BackendError ? err.message : "We couldn't submit your review. Please try again."; }
      });
      writeBox.replaceChildren(el("h2", { text: "Write a review" }), form);
    })();
  }
  const list = approved.length ? el("ul", { class: "rev-list" }, approved.map(r => reviewCard(r))) : el("div", { class: "state state--empty" }, el("h2", { class: "state__title", text: "No reviews yet" }), el("p", { text: "Approved customer reviews will appear here." }));
  slot.replaceChildren(...[summary, mine.length ? el("section", {}, el("h2", { text: "Your pending reviews" }), el("ul", { class: "rev-list" }, mine.map(r => reviewCard(r, { mine: true })))) : null, list, writeBox].filter(Boolean));
}

const page = document.body.dataset.page;
if (page === "wishlist") initWishlist();
else if (page === "reviews") { const s = $("#reviews-contents"); if (s) initReviews(s); }
