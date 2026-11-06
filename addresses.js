// addresses.js — saved addresses: users/{uid}/addresses/{addressId}, plus the default-address pointer users/{uid}.defaultAddressId.
// Rules notes: users.defaultAddressId may only be '' or the ID of an EXISTING address, so a new address is created first and
// the pointer is moved afterwards; when deleting the default, the pointer moves BEFORE the address is deleted.
import { db, collection, doc, getDocs, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from "./firebase.js";
import { $, el, renderEmpty, renderError, renderLoading, renderInactive, showToast, toDate } from "./common.js";
import { requireProfile, updateUserProfile, getUserProfile } from "./auth.js";

export const STATES = ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry"];

/* ---------- validation ---------- */
const squash = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
/** Accepts 10-digit Indian mobiles, optionally typed with +91 / 91 / 0 and spaces or dashes. Returns 10 digits or "". */
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^\d]/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2); else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}
export function validateAddress(raw) {
  const clean = { fullName: squash(raw.fullName), phone: normalizePhone(raw.phone), addressLine1: squash(raw.addressLine1), addressLine2: squash(raw.addressLine2),
    landmark: squash(raw.landmark), city: squash(raw.city), state: squash(raw.state), pincode: String(raw.pincode || "").replace(/\s/g, ""), country: "India" };
  const e = {};
  if (clean.fullName.length < 2 || clean.fullName.length > 80) e.fullName = "Please enter the receiver's full name (2–80 characters).";
  if (!clean.phone) e.phone = "Enter a valid 10-digit Indian mobile number (starting with 6, 7, 8 or 9).";
  if (clean.addressLine1.length < 5 || clean.addressLine1.length > 120) e.addressLine1 = "Please enter house/flat number and street (5–120 characters).";
  if (clean.addressLine2.length > 120) e.addressLine2 = "Please keep this under 120 characters.";
  if (clean.landmark.length > 80) e.landmark = "Please keep this under 80 characters.";
  if (clean.city.length < 2 || clean.city.length > 60) e.city = "Please enter the city or town.";
  if (!STATES.includes(clean.state)) e.state = "Please choose a state or union territory.";
  if (!/^[1-9]\d{5}$/.test(clean.pincode)) e.pincode = "Enter a valid 6-digit PIN code.";
  return { ok: Object.keys(e).length === 0, errors: e, clean };
}
export function addressLines(a) {
  return [a.fullName, [a.addressLine1, a.addressLine2].filter(Boolean).join(", "), a.landmark ? "Near " + a.landmark : "", `${a.city}, ${a.state} ${a.pincode}`, a.country || "India", a.phone ? "Phone: +91 " + a.phone : ""].filter(Boolean);
}

/* ---------- data access (always the signed-in user's own subcollection) ---------- */
const col = (uid) => collection(db, "users", uid, "addresses");
const ref = (uid, id) => doc(db, "users", uid, "addresses", id);
export async function listAddresses(uid) {
  const snap = await getDocs(col(uid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
}
export async function setDefaultAddress(uid, id, addresses) {
  const batch = writeBatch(db);
  for (const a of addresses) if (a.isDefault && a.id !== id) batch.update(ref(uid, a.id), { isDefault: false, updatedAt: serverTimestamp() });
  batch.update(ref(uid, id), { isDefault: true, updatedAt: serverTimestamp() });
  batch.update(doc(db, "users", uid), { defaultAddressId: id, updatedAt: serverTimestamp() });
  await batch.commit();
}
/** Creates an address (first address becomes the default). Returns the new address ID. */
export async function createAddress(uid, clean, { makeDefault = false, existing = [] } = {}) {
  const docRef = await addDoc(col(uid), { ...clean, isDefault: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  if (makeDefault || existing.length === 0) await setDefaultAddress(uid, docRef.id, existing);
  return docRef.id;
}
export async function updateAddress(uid, id, clean, { makeDefault = false, existing = [] } = {}) {
  await updateDoc(ref(uid, id), { ...clean, updatedAt: serverTimestamp() });
  if (makeDefault) await setDefaultAddress(uid, id, existing);
}
export async function deleteAddress(uid, id, addresses, defaultId) {
  const target = addresses.find(a => a.id === id);
  const wasDefault = id === defaultId || (target && target.isDefault);
  if (wasDefault) {
    const next = addresses.filter(a => a.id !== id)[0];
    if (next) await setDefaultAddress(uid, next.id, addresses);
    else await updateUserProfile(uid, { defaultAddressId: "" });
  }
  await deleteDoc(ref(uid, id));
}
/** Repairs a broken/duplicated default pointer. Returns the effective default address ID ("" if none). */
export async function reconcileDefault(uid, addresses, profile) {
  const ids = new Set(addresses.map(a => a.id)), pointer = profile.defaultAddressId || "";
  const flagged = addresses.filter(a => a.isDefault);
  const desired = ids.has(pointer) ? pointer : (flagged[0] ? flagged[0].id : (pointer ? (addresses[0] ? addresses[0].id : "") : ""));
  const flagsOk = desired ? (flagged.length === 1 && flagged[0].id === desired) : flagged.length === 0;
  if (desired === pointer && flagsOk) return desired;
  try {
    if (desired) await setDefaultAddress(uid, desired, addresses);
    else { const batch = writeBatch(db); flagged.forEach(a => batch.update(ref(uid, a.id), { isDefault: false, updatedAt: serverTimestamp() })); batch.update(doc(db, "users", uid), { defaultAddressId: "", updatedAt: serverTimestamp() }); await batch.commit(); }
    addresses.forEach(a => { a.isDefault = a.id === desired; });
    profile.defaultAddressId = desired;
  } catch { /* non-fatal: the UI still works from what was read */ }
  return desired;
}

/* ---------- form ---------- */
const FIELDS = [
  ["fullName", "Full name", "name", "text"], ["phone", "Mobile number", "tel", "tel"], ["addressLine1", "House / flat, street", "address-line1", "text"],
  ["addressLine2", "Area, locality (optional)", "address-line2", "text"], ["landmark", "Landmark (optional)", "off", "text"], ["city", "City / town", "address-level2", "text"]
];
/** Builds an accessible address form. onSubmit(clean, { makeDefault }) may throw/reject; the form shows a friendly error. */
export function buildAddressForm({ initial = {}, onSubmit, onCancel, submitLabel = "Save address", showDefault = true, defaultChecked = false, idPrefix = "af" }) {
  const inputs = {}, errs = {};
  const rows = [];
  const addField = (key, label, ac, type) => {
    const id = `${idPrefix}-${key}`;
    inputs[key] = el("input", { id, name: key, type, autocomplete: ac, value: initial[key] || "", maxlength: key === "phone" ? 20 : 120, inputmode: key === "phone" ? "tel" : null, "aria-describedby": id + "-e" });
    errs[key] = el("p", { class: "field-error", id: id + "-e" });
    return el("div", { class: "field" + (key === "fullName" || key === "addressLine1" || key === "addressLine2" ? " field--wide" : "") }, el("label", { for: id, text: label }), inputs[key], errs[key]);
  };
  FIELDS.slice(0, 2).forEach(f => rows.push(addField(...f)));
  FIELDS.slice(2).forEach(f => { if (f[0] !== "city") rows.push(addField(...f)); });
  rows.push(addField(...FIELDS[5]));
  inputs.state = el("select", { id: `${idPrefix}-state`, name: "state", autocomplete: "address-level1", "aria-describedby": `${idPrefix}-state-e` }, el("option", { value: "", text: "Select state / UT" }), STATES.map(s => el("option", { value: s, selected: s === initial.state, text: s })));
  errs.state = el("p", { class: "field-error", id: `${idPrefix}-state-e` });
  rows.push(el("div", { class: "field" }, el("label", { for: `${idPrefix}-state`, text: "State / UT" }), inputs.state, errs.state));
  inputs.pincode = el("input", { id: `${idPrefix}-pincode`, name: "pincode", type: "text", inputmode: "numeric", autocomplete: "postal-code", maxlength: 6, pattern: "[0-9]{6}", value: initial.pincode || "", "aria-describedby": `${idPrefix}-pincode-e` });
  errs.pincode = el("p", { class: "field-error", id: `${idPrefix}-pincode-e` });
  rows.push(el("div", { class: "field" }, el("label", { for: `${idPrefix}-pincode`, text: "PIN code" }), inputs.pincode, errs.pincode));
  const def = showDefault ? el("input", { type: "checkbox", id: `${idPrefix}-def`, checked: defaultChecked }) : null;
  const status = el("p", { class: "form-status", role: "status" });
  const submit = el("button", { type: "submit", class: "btn btn--primary", text: submitLabel });
  const form = el("form", { class: "addr-form", novalidate: true },
    el("p", { class: "form-hint", text: "Delivery is within India. Please double-check your phone number and address — we use them for delivery." }),
    el("div", { class: "form-grid" }, rows),
    def ? el("label", { class: "check", for: `${idPrefix}-def` }, def, el("span", { text: "Make this my default address" })) : null,
    status, el("div", { class: "form-actions" }, submit, onCancel ? el("button", { type: "button", class: "btn btn--ghost", onclick: onCancel, text: "Cancel" }) : null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = validateAddress(Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value])));
    Object.entries(errs).forEach(([k, p]) => { p.textContent = v.errors[k] || ""; inputs[k].setAttribute("aria-invalid", v.errors[k] ? "true" : "false"); });
    if (!v.ok) { const first = Object.keys(v.errors)[0]; inputs[first].focus(); status.textContent = "Please fix the highlighted fields."; return; }
    submit.disabled = true; status.textContent = "Saving…";
    try { await onSubmit(v.clean, { makeDefault: !!(def && def.checked) }); status.textContent = ""; }
    catch { status.textContent = "We couldn't save this address. Please check your connection and try again."; }
    finally { submit.disabled = false; }
  });
  return form;
}

/* ---------- addresses page ---------- */
async function initAddressesPage(slot) {
  const ctx = await requireProfile(); if (!ctx) return;
  if (ctx.inactive) return renderInactive(slot);
  const { user, profile } = ctx;
  let addresses = [], defaultId = "", editing = null; // editing: address id | "new" | null
  const live = el("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const say = (m) => { live.textContent = m; showToast(m, { type: "success", timeout: 2500 }); };

  async function load() {
    renderLoading(slot, "Loading your addresses…");
    try { Object.assign(profile, await getUserProfile(user)); addresses = await listAddresses(user.uid); defaultId = await reconcileDefault(user.uid, addresses, profile); }
    catch { return renderError(slot, "We couldn't load your addresses. Please try again.", load); }
    render();
  }
  async function act(fn, msg) { try { await fn(); say(msg); editing = null; await load(); } catch { showToast("That didn't work. Please try again.", { type: "error" }); } }

  function card(a) {
    const isDef = a.id === defaultId;
    return el("li", { class: "addr-card" + (isDef ? " is-default" : "") },
      isDef ? el("span", { class: "status-pill", text: "Default" }) : null,
      el("address", { class: "addr-lines" }, addressLines(a).map((l, i) => el(i === 0 ? "strong" : "span", { text: l }))),
      el("div", { class: "addr-actions" },
        el("button", { type: "button", class: "link-btn", onclick: () => { editing = a.id; render(); } }, "Edit"),
        isDef ? null : el("button", { type: "button", class: "link-btn", onclick: () => act(() => setDefaultAddress(user.uid, a.id, addresses), "Default address updated.") }, "Make default"),
        el("button", { type: "button", class: "link-btn link-btn--danger", onclick: () => { if (confirm("Delete this address?")) act(() => deleteAddress(user.uid, a.id, addresses, defaultId), "Address deleted."); } }, "Delete")));
  }
  function render() {
    const parts = [];
    if (editing === "new") parts.push(el("section", { class: "panel" }, el("h2", { text: "New address" }),
      buildAddressForm({ idPrefix: "new", onCancel: () => { editing = null; render(); }, onSubmit: async (clean, o) => { await createAddress(user.uid, clean, { makeDefault: o.makeDefault, existing: addresses }); say("Address saved."); editing = null; await load(); } })));
    else parts.push(el("div", { class: "page-actions" }, el("button", { type: "button", class: "btn btn--primary", onclick: () => { editing = "new"; render(); } }, "Add a new address")));
    if (!addresses.length && editing !== "new") parts.push(el("div", { class: "state state--empty" }, el("h2", { class: "state__title", text: "No saved addresses yet" }), el("p", { text: "Add an address to make checkout quicker." })));
    parts.push(el("ul", { class: "addr-list" }, addresses.map(a => editing === a.id
      ? el("li", { class: "addr-card addr-card--edit" }, el("h2", { text: "Edit address" }), buildAddressForm({ idPrefix: "e" + a.id.slice(0, 6), initial: a, defaultChecked: a.id === defaultId, submitLabel: "Save changes", onCancel: () => { editing = null; render(); },
          onSubmit: async (clean, o) => { await updateAddress(user.uid, a.id, clean, { makeDefault: o.makeDefault && a.id !== defaultId, existing: addresses }); say("Address updated."); editing = null; await load(); } }))
      : card(a))));
    slot.replaceChildren(...parts, live);
  }
  load();
}
const slot = $("#addresses-contents");
if (slot) initAddressesPage(slot);
