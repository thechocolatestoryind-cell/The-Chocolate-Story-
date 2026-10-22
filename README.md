# The Chocolate Story — Customer Storefront (final)

A static, framework-free storefront: HTML + CSS + vanilla JavaScript (ES modules), Firebase (Auth + Firestore) for data, installable as a PWA.
**All 46 files live in ONE flat folder** (no build step, no subfolders). The admin panel is a separate project; this site only reads/writes the same Firebase project within the existing `firestore.rules`.

## 1. Files in this folder
- **HTML pages (12):** account.html, addresses.html, cart.html, checkout.html, index.html, login.html, order-details.html, orders.html, product.html, reviews.html, shop.html, wishlist.html
- **CSS (8):** account.css, cart-checkout.css, home.css, orders.css, product.css, responsive.css, shop.css, style.css (`responsive.css` always loads last)
- **JavaScript modules (12):** account.js, addresses.js, auth.js, cart.js, checkout.js, common.js, firebase.js, home.js, orders.js, product.js, shop.js, wishlist-reviews.js
- **PWA:** `manifest.json`, `sw.js` (service worker), icons `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png`, `favicon.png`
- **Brand/assets:** empty-cart.png, empty-wishlist.png, hero-fallback.jpg, logo-header.webp, logo.png, product-placeholder.png
- **This file:** `README.md`

What each JS module does: `firebase.js` (the only place Firebase is initialised) · `auth.js` (Google-only sign-in, guards, profile) · `common.js` (header/footer, toasts, helpers, backend adapter, service-worker registration) · `home.js` · `shop.js` · `product.js` · `cart.js` (cart storage + the single price/delivery calculation) · `checkout.js` · `account.js` (login + profile) · `addresses.js` · `orders.js` (list, details, cancellation request) · `wishlist-reviews.js`.

## 2. Run locally
Browsers block ES modules on `file://`, so serve the folder: `python3 -m http.server 8080` then open http://localhost:8080 (`localhost` counts as secure, so the service worker also runs).
For Google sign-in to work locally, `localhost` must be in Firebase Console → Authentication → Settings → **Authorized domains** (it normally is by default).

## 3. Deploy to GitHub Pages
1. Create a GitHub repository and upload **every file from this folder to the repository root** (not inside a subfolder).
2. Repository → Settings → Pages → *Build and deployment* → Source: **Deploy from a branch** → branch `main`, folder `/ (root)` → Save.
3. Your site appears at `https://<user>.github.io/<repo>/`. All links are **relative**, so it works from that sub-path and from a custom-domain root with no code change.
4. Add `<user>.github.io` to Firebase **Authorized domains** or Google sign-in will fail with `auth/unauthorized-domain`.

**Custom domain later:** add it in Pages → Custom domain, create the DNS records GitHub shows, tick *Enforce HTTPS*, then (a) add the domain to Firebase Authorized domains, (b) add it to your backend's CORS allow-list, (c) optionally add an absolute `og:image` / canonical URL to each page `<head>` (they need the final domain). Switching domains means customers who installed the app from the old address must reinstall it (service workers and installs are per-origin).
HTTPS is required for the service worker and installation on real devices (GitHub Pages provides it).

## 4. PWA: install and test
- **Android/Chrome/Edge:** an "Install app" link appears in the footer when the browser allows it (or use the browser menu → Install app).
- **iPhone/iPad (Safari):** Share → **Add to Home Screen** (uses `apple-touch-icon.png`). iOS has no install prompt event.
- **Testing:** Chrome DevTools → Application → *Manifest* and *Service Workers*; tick *Offline* and reload to see the cached pages; Lighthouse → PWA/Accessibility.
- **Behaviour:** pages/scripts/styles are network-first (always fresh online; cached copy only when offline or very slow). Same-origin images use stale-while-revalidate. Firestore, Auth, fonts, Cloudinary images, Razorpay and your backend are cross-origin and **never** cached. Offline, previously visited pages open from cache; products/prices need a connection. If nothing is cached, a small branded "You're offline" page is shown.
- **Updates:** when you upload new files, returning customers see "A new version of the shop is ready — Refresh". The page never reloads by itself. To force an update for everyone, change `VERSION` in `sw.js`.

## 5. Firebase
- **Config location:** `firebase.js` (exact values supplied by the owner). The future admin panel must use the same project.
- **Authentication:** Google provider only; customer features require a Google, email-verified account (matches the rules).
- **Reads:** `banners`, `highlights`, `highlightItems`, `categories`, `products` (active only), `reviews` (approved only + the customer's own), `siteSettings/public`, and the signed-in customer's `users/{uid}`, `users/{uid}/addresses`, `wishlists`, `orders`, `shipments`, `paymentTransactions`.
- **Writes (allowed by the rules):** `users/{uid}` (create on first sign-in, edit name/phone/default address), `users/{uid}/addresses`, `wishlists/{uid}`.
- **Never written from the browser:** orders, payments, shipments, stock, reviews, order status (the rules forbid it — see section 7).
- **Indexes:** every query uses one or two equality filters with client-side sorting, so **no composite indexes are needed**.
- **Wishlist note:** a plain `get` on a missing wishlist is denied by the rules, so wishlists are read with a `userId ==` query and created with document ID = the customer's UID.

## 6. Cloudinary
Product, banner, highlight and category images are **https URLs stored in Firestore** (Cloudinary). The storefront only displays them (http/https URLs only); it never uploads and holds no Cloudinary credentials. For fast pages store delivery URLs with transformations such as `f_auto,q_auto,w_900`. Broken images fall back to `product-placeholder.png`. A product's `images` array may contain plain URL strings (what the admin panel saves) and/or objects like `{ url, alt, sortOrder }`; `primaryImage` is shown first, the rest follow in order. The product page has arrows, thumbnails, swipe and a "1 / 3" counter.

**Sharing a product:** the product page has a *Share this product* button. On phones it opens the native share sheet; elsewhere it offers *Share on WhatsApp* and *Copy link*. The message contains the product name, short description, price, "100% eggless · Delivered across India" and a clean link (`product.html?id=<id>`). Note: this is a static site, so the *link-preview card* (image/title shown by WhatsApp under a link) cannot be made per product; the details are therefore written into the message text itself.

## 7. Trusted backend (required before real orders)
Under the current rules customers cannot create orders, record payments, cancel orders or submit reviews, so a small server you control must do it (e.g. Cloud Run / Cloud Functions / any HTTPS API using the **Firebase Admin SDK** and the **Razorpay secret**).
Set its address in `common.js`:
```js
export const BACKEND_CONFIG = { baseUrl: "https://api.your-domain.com", endpoints: { ... } };
```
While `baseUrl` is empty: the Pay button, cancellation request and review form stay disabled and customers see a clear explanation (checkout offers a WhatsApp order message instead).
Every call is `POST` JSON with `Authorization: Bearer <Firebase ID token>`. Verify the token, take the UID **from the token** (never from the body), allow CORS only for your storefront origin(s). Errors: non-2xx with `{"error":{"code":"...","message":"customer-safe text"}}`.

**`POST /checkout/create-order`**
Request: `{ clientRequestId, addressId, customerNote, items:[{ productId, quantity, selections:[{ group, label, text? }] }] }`.
Server must: load the address from `users/{uid}/addresses/{addressId}`; load each product (active, available, stock, quantity limits); recompute every price from Firestore (base price + option adjustments); apply delivery **once per distinct product**; reject unknown/unavailable options; create the `orders` document (`userId`, status/paymentStatus `pending`, item + address snapshots, totals, order number) **idempotently on (uid, clientRequestId)**; create the Razorpay order with the server-held key; write a `paymentTransactions` record.
Response: `{ orderId, orderNumber, razorpayKeyId, razorpayOrder:{ id, amount /*paise, integer*/, currency:"INR" }, totals:{ subtotal, deliveryCharge, totalAmount } }`. The browser opens Razorpay only with this data, and asks the customer to confirm if `amount` differs from what was displayed.

**`POST /checkout/verify-payment`**
Request: `{ orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }`.
Server must: confirm the order belongs to the UID; verify the HMAC-SHA256 signature of `razorpayOrderId|razorpayPaymentId` with the Razorpay **secret** (ideally also confirm capture via Razorpay's API); mark the transaction/order paid and decrement stock atomically. Also implement a **Razorpay webhook** (`payment.captured`, `payment.failed`) as the source of truth — the browser callback alone is not enough.
Response: `{ verified: true, orderId, orderNumber }` (anything else is shown as "confirming your payment"; the cart is cleared only on `verified:true`).

**`POST /orders/cancel`** — `{ orderId }`. Only the owner; only while status is pending/confirmed/processing and nothing has shipped; apply your refund policy via Razorpay. Respond `{ ok:true }`. The page always re-reads the real order from Firestore afterwards.

**`POST /reviews/submit`** — `{ orderId, productId, rating(1–5), reviewText(≤1000) }`. Verify the order is the customer's, delivered, contains the product, and not already reviewed; create the `reviews` document with `isApproved:false` (and `isVerifiedPurchase:true`) so the admin can approve it.

## 8. Business rules the site states to customers
100% eggless · PAN India delivery · online payment only (no Cash on Delivery) · delivery usually around 6–8 days from the order date, shown as an **estimate, never a guarantee** · each product's `deliveryCharge` is applied **once per product** (not per unit) · cancellation only before shipping.

## 9. Owner checklist — what you will need to provide later
1. **Backend base URL** (section 7) → paste into `BACKEND_CONFIG.baseUrl` in `common.js`.
2. **Razorpay**: test then live **Key ID** (returned by your backend, not stored here) and the **Key Secret + webhook secret** (stored ONLY on the backend, never in these files).
3. **Firebase Admin service-account credentials** (backend only).
4. **Domain**: GitHub Pages / custom domain → add to Firebase Authorized domains and backend CORS; absolute `og:image`/canonical if wanted.
5. **`float.png`** (optional floating custom-order icon): add it to the folder and set `FLOAT_IMAGE_FILE = "float.png"` in `home.js`.
6. **Product options format**: an example of a real `options` array from the admin panel (the site's reader in `cart.js → normalizeOptions` is tolerant but was built without a real sample).
7. **Confirm policies**: delivery charge once per product; quantity cap of 20 per line (`MAX_QTY` in `common.js`).
8. Fill `siteSettings/public` (contact email, WhatsApp number, Instagram URL, announcement, maintenance mode) — the site has built-in fallbacks.

## 10. Verification status (be clear about what was and wasn't tested)
Tested in headless Chromium (phone 320/390 px and desktop 1280 px) with a **mock Firestore** that enforced the rules' exact field lists and default-address check, and a **mock backend and mock Razorpay**: all 12 pages (signed-in and signed-out) for console errors, horizontal overflow, one `h1`, labels/names/alt text, duplicate IDs and tap-target size; shop filters/sorting; cart maths and corrupted storage; address CRUD and default-pointer repair; checkout payment flow including amount mismatch, server errors, dismissed payment and pending verification; orders/shipment display; reviews; service-worker precache, real offline loading (server stopped), update prompt and install button; reduced-motion; no secrets in files.
**NOT tested:** your real Firestore/rules, a real Razorpay payment, a real backend (none exists yet), real Cloudinary images, real phones/browsers other than Chromium, or screen readers. Do a Razorpay **test-mode** run end-to-end before launch.

## 11. Troubleshooting
- *Google sign-in popup fails:* domain missing from Firebase Authorized domains, or pop-ups blocked (the site falls back to redirect).
- *Blank sections on the homepage:* the collection is empty or has no `isActive: true` documents — the site hides empty sections by design.
- *"Missing or insufficient permissions" in the console:* the document isn't active/owned by the signed-in user (rules are deliberately strict).
- *Old version still showing:* accept the "Refresh" prompt, or hard-reload; bump `VERSION` in `sw.js` when you publish.
