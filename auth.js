// auth.js — Google-only authentication helpers and guards.
import {
  auth, db, googleProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, doc, getDoc, setDoc, updateDoc, serverTimestamp
} from "./firebase.js";

// Pages that may be used as a post-login destination (root-level, relative).
const SAFE_NEXT_PAGES = [
  "index.html", "shop.html", "product.html", "cart.html", "checkout.html", "account.html",
  "addresses.html", "orders.html", "order-details.html", "wishlist.html", "reviews.html"
];

/** Returns a safe same-site relative destination, or "account.html". Rejects absolute/external URLs. */
export function safeNext(raw) {
  try {
    if (!raw || typeof raw !== "string" || raw.length > 300) return "account.html";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.includes("\\")) return "account.html";
    const clean = raw.replace(/^\.?\//, "");
    const page = clean.split(/[?#]/)[0];
    return SAFE_NEXT_PAGES.includes(page) ? clean : "account.html";
  } catch { return "account.html"; }
}

/** Resolves once Firebase has restored any existing session. */
export async function authReady() {
  if (typeof auth.authStateReady === "function") await auth.authStateReady();
  return auth.currentUser;
}


/** Subscribe to sign-in changes. Returns the unsubscribe function. */
export function onUserChange(callback) { return onAuthStateChanged(auth, callback); }

/** Customer features require a Google-provider, email-verified account (matches firestore.rules). */
export function isGoogleUser(user = auth.currentUser) {
  return !!user && user.emailVerified === true && user.providerData.some(p => p.providerId === "google.com");
}

/** Friendly message for a Firebase auth error code. */
export function authErrorMessage(err) {
  switch (err && err.code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return "Sign-in was cancelled. You can try again whenever you're ready.";
    case "auth/network-request-failed": return "We couldn't reach the sign-in service. Please check your connection and try again.";
    case "auth/unauthorized-domain": return "This website address isn't authorised for Google sign-in yet. Please contact The Chocolate Story.";
    case "auth/too-many-requests": return "Too many attempts. Please wait a moment and try again.";
    case "auth/user-disabled": return "This account has been disabled. Please contact The Chocolate Story.";
    default: return "Sign-in didn't complete. Please try again.";
  }
}

/** Google sign-in. Uses a popup, falling back to redirect if the popup is blocked. */
export async function signInWithGoogle() {
  try {
    const cred = await signInWithPopup(auth, googleProvider);
    return cred.user;
  } catch (err) {
    if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
      await signInWithRedirect(auth, googleProvider); // page navigates away
      return null;
    }
    throw err;
  }
}

/** Completes a redirect sign-in, if one is pending. */
export async function completeRedirectSignIn() {
  try { const res = await getRedirectResult(auth); return res ? res.user : null; }
  catch (err) { throw err; }
}

export async function signOutUser() { await signOut(auth); }

/**
 * Creates users/{uid} on first sign-in using exactly the field set firestore.rules requires.
 * Never overwrites an existing profile. Returns true if a profile was created.
 */
export async function ensureUserProfile(user) {
  if (!isGoogleUser(user)) throw new Error("A verified Google account is required.");
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return false;
  await setDoc(ref, {
    isActive: true,
    displayName: user.displayName || "",
    photoURL: user.photoURL || "",
    phoneNumber: "",
    email: user.email,
    defaultAddressId: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return true;
}

/**
 * Auth guard for private pages. Resolves with the signed-in Google user, or redirects to login.html
 * (with a safe `next` parameter) and resolves with null.
 */
export async function requireAuth() {
  const user = await authReady();
  if (isGoogleUser(user)) return user;
  const here = (location.pathname.split("/").pop() || "index.html") + location.search;
  location.replace("login.html?next=" + encodeURIComponent(safeNext(here)));
  return null;
}

/** Loads (creating on first sign-in) the customer's users/{uid} profile. */
export async function getUserProfile(user) {
  await ensureUserProfile(user);
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
/** Updates only fields the rules let customers change; `updatedAt` is always the server time. */
export async function updateUserProfile(uid, fields) {
  const allowed = ["displayName", "photoURL", "phoneNumber", "defaultAddressId"];
  const data = {};
  for (const k of allowed) if (k in fields) data[k] = String(fields[k] == null ? "" : fields[k]);
  await updateDoc(doc(db, "users", uid), { ...data, updatedAt: serverTimestamp() });
}
/** Auth guard + profile bootstrap for private pages. Resolves { user, profile, inactive } or null (redirected to login). */
export async function requireProfile() {
  const user = await requireAuth();
  if (!user) return null;
  const profile = await getUserProfile(user);
  return { user, profile, inactive: !profile || profile.isActive === false };
}
