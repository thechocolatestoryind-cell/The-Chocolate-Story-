// google-links.js — "Review us on Google" links, the share option and the post-delivery prompt. No backend: these are plain links to the
// shop's Google Business Profile. The prompt is shown only to a signed-in customer viewing their own DELIVERED order (never to anonymous visitors),
// once per order; "Maybe later" asks again after 7 days. Nothing here touches orders, payments or reviews data.
import { el } from "./common.js";

export const GOOGLE_REVIEW_URL = "https://g.page/r/Cb3X4Tcv_lHIEBM/review";        // opens Google's "write a review" form for the shop
export const GOOGLE_PROFILE_URL = "https://share.google/GG28T0oVNkkmbz1xk";        // the shop's Google profile, where all reviews are shown
const SHARE_TEXT = "I loved my order from The Chocolate Story! If you've tried them too, you can leave a review on Google.";
const KEY = (id) => "tcs_gprompt_v1_" + id, LATER_MS = 7 * 864e5;

const ext = { target: "_blank", rel: "noopener noreferrer" };
export const googleReviewLink = (text = "Review us on Google", cls = "btn btn--ghost", onclick) => el("a", { class: cls, href: GOOGLE_REVIEW_URL, ...ext, ...(onclick ? { onclick } : {}) }, text);
export const googleProfileLink = (text = "See our reviews on Google", cls = "btn btn--ghost") => el("a", { class: cls, href: GOOGLE_PROFILE_URL, ...ext }, text);

/** Native share sheet where available (phones), otherwise WhatsApp share link; always keeps the Google review form link in the message. */
export function shareInvite() {
  const text = SHARE_TEXT, url = GOOGLE_REVIEW_URL;
  if (navigator.share) return navigator.share({ title: "The Chocolate Story", text, url }).catch(() => {});          // user cancelling is fine
  window.open("https://wa.me/?text=" + encodeURIComponent(text + "\n" + url), "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

const read = (id) => { try { return JSON.parse(localStorage.getItem(KEY(id)) || "null"); } catch { return null; } };
const write = (id, state) => { try { localStorage.setItem(KEY(id), JSON.stringify({ state, at: Date.now() })); } catch { /* ignore */ } };
let scheduled = false;

/** Shows the Google prompt once, ~2.5 s after a delivered order is viewed. */
export function scheduleGooglePrompt(orderId, delay = 2500) {
  if (scheduled || !orderId) return;
  const seen = read(orderId);
  if (seen && (seen.state === "done" || Date.now() - seen.at < LATER_MS)) return;
  scheduled = true;
  setTimeout(() => { if (document.visibilityState === "visible" && !document.querySelector(".gp-modal")) open(orderId); else scheduled = false; }, delay);
}

function open(orderId) {
  const prev = document.activeElement;
  let wrap;
  const close = (state) => { if (state) write(orderId, state); document.removeEventListener("keydown", onKey); wrap.remove(); document.body.style.overflow = ""; scheduled = false; if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === "Escape") close("later"); };
  const share = el("button", { type: "button", class: "btn btn--ghost gp-share", onclick: () => shareInvite() }, "Share with friends");
  wrap = el("div", { class: "gp-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "gp-title", onclick: (e) => { if (e.target === wrap) close("later"); } },
    el("div", { class: "gp-card" },
      el("div", { class: "gp-top" }, share),
      el("h2", { id: "gp-title", text: "Enjoyed your order?" }),
      el("p", { text: "Your Google review helps other chocolate lovers find The Chocolate Story. It takes less than a minute." }),
      googleReviewLink("Write a review on Google", "btn btn--primary btn--block", () => { write(orderId, "done"); setTimeout(() => close(), 300); }),
      el("p", { class: "summary-note", text: "Opens Google in a new tab. You'll need to be signed in to your Google account." }),
      el("button", { type: "button", class: "link-btn", onclick: () => close("later") }, "Maybe later")));
  document.body.append(wrap); document.body.style.overflow = "hidden"; document.addEventListener("keydown", onKey);
  const first = wrap.querySelector("button, a"); if (first) first.focus();
}
