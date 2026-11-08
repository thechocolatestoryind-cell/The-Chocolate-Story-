// wishlist-reviews.js — wishlist (Stage 3) and the reviews page (Stage 4).
// Wishlist doc: wishlists/{uid} = { userId, productIds[], createdAt, updatedAt } — exactly the fields firestore.rules allow.
import { db, collection, doc, getDoc, getDocs, query, where, limit, setDoc, updateDoc, serverTimestamp, arrayUnion, arrayRemove } from "./firebase.js";
import { $, el, showToast, renderEmpty, renderError, renderLoading, productCard, setWishState, formatDate } from "./common.js";
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
// Reviews can be READ here (approved ones, plus your own). A signed-in customer can WRITE one review per product of each of their DELIVERED
// orders, with up to 3 photos. The review is saved as reviews/{orderId}_{productId} with isApproved:false; the Firestore rules verify the order is
// theirs, delivered and contains the product, so nothing is shown publicly until the admin approves it. Photos go to Cloudinary (unsigned preset).
const CLOUD = { uploadUrl: "https://api.cloudinary.com/v1_1/dyt6fwvw0/image/upload", uploadPreset: "Wb_mobile_products" };   // same cloud as the admin panel
const PHOTO = { types: ["image/jpeg", "image/png", "image/webp"], max: 3, maxBytes: 8 * 1024 * 1024, maxSide: 1600 };
const cloudUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === "res.cloudinary.com"; } catch { return false; } };
/** Downscales large phone photos before upload (saves data); falls back to the original file on any problem. */
async function shrink(file) {
  try {
    const url = URL.createObjectURL(file), img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; }); URL.revokeObjectURL(url);
    const side = Math.max(img.naturalWidth, img.naturalHeight); if (side <= PHOTO.maxSide && file.size <= 1.5 * 1024 * 1024) return file;
    const k = Math.min(1, PHOTO.maxSide / side), c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", .85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}
function uploadPhoto(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData(); fd.append("file", file); fd.append("upload_preset", CLOUD.uploadPreset);
    const xhr = new XMLHttpRequest(); xhr.open("POST", CLOUD.uploadUrl); xhr.timeout = 90000;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onerror = () => reject(new Error("net")); xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.onload = () => { let j = null; try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ } (xhr.status >= 200 && xhr.status < 300 && j && cloudUrl(j.secure_url)) ? resolve(j.secure_url) : reject(new Error("refused")); };
    xhr.send(fd);
  });
}
const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
const clampRating = (v) => Math.min(5, Math.max(0, Math.round(Number(v) || 0)));
const ms = (v) => (v && typeof v.toMillis === "function") ? v.toMillis() : 0;
function reviewCard(r, { mine = false } = {}) {
  const n = clampRating(r.rating);
  return el("li", { class: "rev rev--full" },
    el("p", { class: "rev__stars", role: "img", "aria-label": `Rated ${n} out of 5` }, stars(n)),
    el("blockquote", { class: "rev__text" }, el("p", { text: String(r.reviewText || "").slice(0, 1000) })),
    Array.isArray(r.imageURLs) && r.imageURLs.some(cloudUrl) ? el("ul", { class: "rev__photos" }, r.imageURLs.filter(cloudUrl).slice(0, 3).map(u => el("li", {}, el("a", { href: u, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open customer photo" }, el("img", { src: u, alt: "Photo shared by a customer", width: 72, height: 72, loading: "lazy" }))))) : null,
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
  let mine = [], mineAll = [];
  if (signedIn) { try { mineAll = (await getDocs(query(collection(db, "reviews"), where("userId", "==", user.uid), limit(100)))).docs.map(d => ({ id: d.id, ...d.data() })); mine = mineAll.filter(r => r.isApproved !== true).sort((a, b) => ms(b.createdAt) - ms(a.createdAt)); } catch { /* optional */ } }

  const avg = approved.length ? approved.reduce((s, r) => s + clampRating(r.rating), 0) / approved.length : 0;
  const summary = approved.length ? el("div", { class: "rev-summary" }, el("strong", { class: "rev-summary__n", text: avg.toFixed(1) }), el("div", {}, el("p", { class: "rev__stars", role: "img", "aria-label": `Average rating ${avg.toFixed(1)} out of 5` }, stars(Math.round(avg))), el("p", { class: "summary-note", text: `Based on ${approved.length} approved review${approved.length === 1 ? "" : "s"}` }))) : null;

  const writeBox = el("section", { class: "panel" }, el("h2", { text: "Write a review" }));
  if (!signedIn) writeBox.append(el("p", { text: "Sign in to review products from your delivered orders." }), el("a", { class: "btn btn--primary", href: "login.html?next=reviews.html", text: "Sign in" }));
  else {
    writeBox.append(el("p", { class: "summary-note", text: "Loading your delivered orders…" }));
    (async () => {
      const head = () => writeBox.replaceChildren(el("h2", { text: "Write a review" }));
      const done = new Set(mineAll.map(r => r.id));
      let orders = [];
      try { orders = (await getDocs(query(collection(db, "orders"), where("userId", "==", user.uid), limit(60)))).docs.map(d => ({ id: d.id, ...d.data() })).filter(o => String(o.status).toLowerCase() === "delivered" && Array.isArray(o.items)); }
      catch { head(); writeBox.append(el("p", { text: "We couldn't load your orders. Please try again later." })); return; }
      const todo = (o) => o.items.filter(i => i && typeof i.productId === "string" && !done.has(o.id + "_" + i.productId));
      orders = orders.filter(o => todo(o).length);
      if (!orders.length) { head(); writeBox.append(el("p", { text: mineAll.length ? "You've reviewed everything from your delivered orders — thank you!" : "Once an order is delivered, you can review its products here." })); return; }
      const orderSel = el("select", { id: "rv-order" }, orders.map(o => el("option", { value: o.id, text: `Order ${o.orderNumber || o.id.slice(0, 6)}` })));
      const prodSel = el("select", { id: "rv-prod" });
      const fill = () => { const o = orders.find(x => x.id === orderSel.value); prodSel.replaceChildren(...todo(o).map(i => el("option", { value: i.productId, text: String(i.name || i.productName || "Product").slice(0, 80) }))); };
      const qs = new URLSearchParams(location.search); if (orders.some(o => o.id === qs.get("order"))) orderSel.value = qs.get("order");
      orderSel.addEventListener("change", fill); fill();
      const text = el("textarea", { id: "rv-text", rows: 4, maxlength: 1000, placeholder: "Tell others what you thought (max 1000 characters)" });
      const rate = el("fieldset", { class: "rate" }, el("legend", { text: "Your rating" }), [1, 2, 3, 4, 5].map(n => el("span", { class: "rate__opt" }, el("input", { type: "radio", name: "rating", id: "rt" + n, value: String(n) }), el("label", { for: "rt" + n, "aria-label": `${n} star${n > 1 ? "s" : ""}`, text: `${n} ★` }))));
      /* photos */
      const picked = [];                                     // { file, preview, remote }
      const grid = el("ul", { class: "rv-photos" }), input = el("input", { type: "file", id: "rv-photos", accept: PHOTO.types.join(","), multiple: true, class: "visually-hidden" });
      const addLabel = el("label", { class: "btn btn--ghost rv-add" }, "Add photos", input);
      const photoNote = el("p", { class: "summary-note", text: `Optional · up to ${PHOTO.max} photos · JPG, PNG or WebP · each up to 8 MB.` });
      const paint = () => {
        grid.replaceChildren(...picked.map((p, i) => el("li", { class: "rv-photo" }, el("img", { src: p.preview, alt: `Selected photo ${i + 1}`, width: 84, height: 84 }),
          el("button", { type: "button", class: "rv-photo__x", "aria-label": `Remove photo ${i + 1}`, onclick: () => { URL.revokeObjectURL(p.preview); picked.splice(i, 1); paint(); } }, "×"))));
        addLabel.hidden = picked.length >= PHOTO.max;
      };
      input.addEventListener("change", () => {
        for (const f of [...input.files]) {
          if (picked.length >= PHOTO.max) { status.textContent = `You can add up to ${PHOTO.max} photos.`; break; }
          if (!PHOTO.types.includes(f.type)) { status.textContent = "Please use JPG, PNG or WebP photos."; continue; }
          if (f.size > PHOTO.maxBytes) { status.textContent = "A photo is larger than 8 MB. Please choose a smaller one."; continue; }
          picked.push({ file: f, preview: URL.createObjectURL(f), remote: "" });
        }
        input.value = ""; paint();
      });
      const status = el("p", { class: "form-status", role: "status" });
      const btn = el("button", { type: "submit", class: "btn btn--primary", text: "Submit review" });
      const form = el("form", { novalidate: true }, el("div", { class: "form-grid" }, el("div", { class: "field" }, el("label", { for: "rv-order", text: "Order" }), orderSel), el("div", { class: "field" }, el("label", { for: "rv-prod", text: "Product" }), prodSel)), rate,
        el("div", { class: "field field--wide" }, el("label", { for: "rv-text", text: "Your review" }), text),
        el("div", { class: "field field--wide" }, el("span", { class: "rv-label", text: "Photos" }), grid, addLabel, photoNote), status, el("div", { class: "form-actions" }, btn));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const rating = Number((form.querySelector('input[name="rating"]:checked') || {}).value), body = text.value.trim(), orderId = orderSel.value, productId = prodSel.value;
        if (!productId) { status.textContent = "Please choose a product."; return; }
        if (!(rating >= 1 && rating <= 5)) { status.textContent = "Please choose a star rating."; return; }
        if (body.length < 5) { status.textContent = "Please write a few words about the product."; text.focus(); return; }
        btn.disabled = true; input.disabled = true;
        try {
          for (let i = 0; i < picked.length; i++) {
            if (picked[i].remote) continue;                  // already uploaded on an earlier attempt: don't upload twice
            status.textContent = `Uploading photo ${i + 1} of ${picked.length}…`;
            const f = await shrink(picked[i].file);
            picked[i].remote = await uploadPhoto(f, (pct) => { status.textContent = `Uploading photo ${i + 1} of ${picked.length}… ${pct}%`; });
          }
        } catch { btn.disabled = false; input.disabled = false; status.textContent = "We couldn't upload a photo. Please check your connection and try again, or remove the photo."; return; }
        status.textContent = "Submitting…";
        try {
          await setDoc(doc(db, "reviews", orderId + "_" + productId), { userId: user.uid, orderId, productId, rating, reviewText: body, imageURLs: picked.map(p => p.remote), isApproved: false, isVerifiedPurchase: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          picked.forEach(p => URL.revokeObjectURL(p.preview));
          form.replaceChildren(el("p", { role: "status", text: "Thank you! Your review was received and will appear after it has been checked." }));
        } catch (err) { btn.disabled = false; input.disabled = false; status.textContent = err && err.code === "permission-denied" ? "We couldn't submit this review. You may have already reviewed this product, or the order isn't eligible." : "We couldn't submit your review. Please try again."; }
      });
      head(); writeBox.append(form); paint();
    })();
  }
  const list = approved.length ? el("ul", { class: "rev-list" }, approved.map(r => reviewCard(r))) : el("div", { class: "state state--empty" }, el("h2", { class: "state__title", text: "No reviews yet" }), el("p", { text: "Approved customer reviews will appear here." }));
  slot.replaceChildren(...[summary, mine.length ? el("section", {}, el("h2", { text: "Your pending reviews" }), el("ul", { class: "rev-list" }, mine.map(r => reviewCard(r, { mine: true })))) : null, list, writeBox].filter(Boolean));
}

const page = document.body.dataset.page;
if (page === "wishlist") initWishlist();
else if (page === "reviews") { const s = $("#reviews-contents"); if (s) initReviews(s); }
