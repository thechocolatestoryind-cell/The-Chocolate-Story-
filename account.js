// account.js — serves login.html (Google sign-in) and account.html (profile view/edit).
import { $, el, safeUrl, renderInactive, showToast } from "./common.js";
import { normalizePhone } from "./addresses.js";
import {
  authReady, isGoogleUser, signInWithGoogle, completeRedirectSignIn, ensureUserProfile,
  authErrorMessage, safeNext, requireProfile, updateUserProfile
} from "./auth.js";

async function initLogin() {
  const slot = $("#login-card");
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const status = el("p", { class: "form-status", role: "status" });
  const btn = el("button", { type: "button", class: "btn btn--google" }, "Continue with Google");
  const finish = async (user) => {
    await ensureUserProfile(user);
    location.replace(next);
  };
  const run = async (fn) => {
    btn.disabled = true; status.textContent = "Signing you in…";
    try { const user = await fn(); if (user) await finish(user); else status.textContent = ""; }
    catch (err) {
      status.textContent = "";
      showToast(err && err.code ? authErrorMessage(err) : "We couldn't set up your profile. Please try again.", { type: "error" });
      btn.disabled = false;
    }
  };
  slot.replaceChildren(
    el("img", { src: "logo-header.webp", alt: "The Chocolate Story", width: 1380, height: 719 }),
    el("h1", { class: "auth-card__title", text: "Sign in" }),
    el("p", { text: "We use Google sign-in only. You can browse and add to your cart without an account; sign in to check out, save addresses and see your orders." }),
    btn, status);
  btn.addEventListener("click", () => run(signInWithGoogle));
  // finish a redirect sign-in if one was started, or continue an existing session
  try {
    const redirected = await completeRedirectSignIn();
    if (redirected) return run(async () => redirected);
  } catch (err) { showToast(authErrorMessage(err), { type: "error" }); }
  const existing = await authReady();
  if (isGoogleUser(existing)) {
    status.textContent = "You're already signed in.";
    btn.textContent = "Continue"; btn.onclick = () => run(async () => existing);
  }
}

async function initAccount() {
  const slot = $("#account-contents");
  const ctx = await requireProfile();
  if (!ctx) return;
  if (ctx.inactive) return renderInactive(slot);
  const { user, profile } = ctx;
  const photo = safeUrl(profile.photoURL || user.photoURL);
  const nameIn = el("input", { id: "pf-name", name: "displayName", type: "text", autocomplete: "name", maxlength: 80, value: profile.displayName || "" });
  const phoneIn = el("input", { id: "pf-phone", name: "phone", type: "tel", autocomplete: "tel", inputmode: "tel", maxlength: 20, value: profile.phoneNumber || "", "aria-describedby": "pf-phone-e" });
  const phoneErr = el("p", { class: "field-error", id: "pf-phone-e" });
  const status = el("p", { class: "form-status", role: "status" });
  const save = el("button", { type: "submit", class: "btn btn--primary", text: "Save changes" });
  const form = el("form", { class: "panel", novalidate: true },
    el("h2", { text: "Your details" }),
    el("div", { class: "form-grid" },
      el("div", { class: "field field--wide" }, el("label", { for: "pf-name", text: "Name" }), nameIn),
      el("div", { class: "field field--wide" }, el("label", { for: "pf-email", text: "Email (from your Google account)" }), el("input", { id: "pf-email", type: "email", value: user.email || "", readonly: true, "aria-readonly": "true" })),
      el("div", { class: "field field--wide" }, el("label", { for: "pf-phone", text: "Mobile number (optional)" }), phoneIn, phoneErr)),
    status, el("div", { class: "form-actions" }, save));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameIn.value.replace(/\s+/g, " ").trim(), rawPhone = phoneIn.value.trim(), phone = rawPhone ? normalizePhone(rawPhone) : "";
    phoneErr.textContent = ""; phoneIn.setAttribute("aria-invalid", "false");
    if (rawPhone && !phone) { phoneErr.textContent = "Enter a valid 10-digit Indian mobile number."; phoneIn.setAttribute("aria-invalid", "true"); phoneIn.focus(); return; }
    if (name.length > 80) { status.textContent = "Please keep your name under 80 characters."; return; }
    save.disabled = true; status.textContent = "Saving…";
    try { await updateUserProfile(user.uid, { displayName: name, phoneNumber: phone }); status.textContent = ""; phoneIn.value = phone; showToast("Your details were saved.", { type: "success" }); }
    catch { status.textContent = "We couldn't save your details. Please check your connection and try again."; }
    finally { save.disabled = false; }
  });
  const tile = (href, title, text) => el("a", { class: "tile", href }, el("strong", { text: title }), el("span", { text }));
  slot.replaceChildren(el("div", { class: "profile-grid" },
    el("section", { class: "panel profile-head" },
      photo ? el("img", { class: "avatar", src: photo, alt: "", width: 72, height: 72, referrerpolicy: "no-referrer" }) : el("span", { class: "avatar avatar--blank", "aria-hidden": "true", text: (profile.displayName || user.email || "?").slice(0, 1).toUpperCase() }),
      el("div", {}, el("h2", { text: profile.displayName || "Welcome" }), el("p", { class: "summary-note", text: user.email || "" })),
      el("button", { type: "button", class: "btn btn--ghost", "data-signout": "", text: "Sign out" })),
    form,
    el("div", { class: "tiles" }, tile("orders.html", "My orders", "Track and review your orders"), tile("addresses.html", "Saved addresses", "Manage your delivery addresses"), tile("wishlist.html", "Wishlist", "Products you've saved"))));
}

const page = document.body.dataset.page;
if (page === "login") initLogin(); else if (page === "account") initAccount();
