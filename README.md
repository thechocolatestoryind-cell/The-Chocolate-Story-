# The Chocolate Story — Customer Storefront (final)

A static, framework-free storefront: HTML + CSS + vanilla JavaScript (ES modules), Firebase (Auth + Firestore) for data, a small Cloud Function for secure order creation, installable as a PWA.
**All site files live in ONE flat folder** (no build step; the only subfolder is `functions/`, the secure order backend). The admin panel is a separate project; this site only reads/writes the same Firebase project within the existing `firestore.rules`.

## 1. Files in this folder
- **HTML pages (12):** account.html, addresses.html, cart.html, checkout.html, index.html, login.html, order-details.html, orders.html, product.html, reviews.html, shop.html, wishlist.html
- **CSS (8):** account.css, cart-checkout.css, home.css, orders.css, product.css, responsive.css, shop.css, style.css (`responsive.css` always loads last)
- **JavaScript modules (12):** account.js, addresses.js, auth.js, cart.js, checkout.js, common.js, firebase.js, home.js, orders.js, product.js, shop.js, wishlist-reviews.js
- **PWA:** `manifest.json`, `sw.js` (service worker), icons `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png`, `favicon.png`
- **Brand/assets:** empty-cart.png, empty-wishlist.png, hero-fallback.jpg, logo-header.webp, logo.png, product-placeholder.png
- **This file:** `README.md`

What each JS module does: `firebase.js` (the only place Firebase is initialised) · `auth.js` (Google-only sign-in, guards, profile) · `common.js` (header/footer, toasts, helpers, backend adapter, service-worker registration) · `home.js` · `shop.js` · `product.js` · `cart.js` (cart storage + the single price/delivery calculation) · `checkout.js` · `upi.js` (UPI link, WhatsApp proof, Confirm Purchase popup) · `account.js` (login + profile) · `addresses.js` · `orders.js` (list, details, cancellation request) · `wishlist-reviews.js`.

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

## 7. Ordering and payment (manual UPI) — how it works
1. The customer signs in with Google, picks a saved address and presses **Place order** on `checkout.html`.
2. The browser calls the trusted backend (`functions/`, a Firebase Cloud Function). The browser sends ONLY product IDs, quantities, selected options and an address ID — never prices. The backend recomputes every price and delivery charge from Firestore and creates the order in `orders` with `status: "pending"`, `paymentStatus: "pending"`, `paymentMethod: "upi_manual"`, using the existing order schema (plus `clientRequestId` for safe retries).
3. The page shows **Pay with any UPI App**: a `upi://pay?...` link containing the merchant UPI ID, the server-computed amount, `cu=INR`, a note and the order number as reference. On Android this opens the UPI app chooser. There is no QR code and no COD.
4. Opening a UPI app, or returning from it, proves nothing. The customer taps **Confirm Purchase**, sees the popup (English + Roman Urdu) and taps **Send Payment Proof via WhatsApp**, which opens WhatsApp to +91 88470 50895 with a prefilled message (name, order ID, amount, items). The customer attaches the screenshot and sends it themselves — a website cannot do this automatically.
5. An admin checks the payment and moves the order to *confirmed* in the admin panel. The customer's tracking page (`order-details.html`) reads the real status from Firestore (use **Refresh status** or reload).

**Configuration:** the merchant UPI ID, payee name and WhatsApp number are constants at the top of `upi.js` (`PAYMENT_CONFIG`). They are deliberately NOT in `siteSettings/public`. The backend address is `BACKEND_CONFIG` in `common.js`.

**Order statuses shown to customers:** `pending` = Pending Payment Verification · `confirmed` = Order Confirmed · `shipped` = Shipped · `delivered` = Delivered (and `cancelled`). The admin's extra `processing` step is shown inside "Order Confirmed — being prepared". Nothing is simulated: no timers, no automatic progress, no courier scans. Tracking number/link appear only if the admin has really entered them on the shipment.

**Cancellation:** allowed only before *shipped* (pending, confirmed, processing). Customers cannot write to `orders` (rules), so the request goes to the backend (`/orders/cancel`), which only changes `status` to `cancelled`. It does not refund anything.

### Backend deployment (Firebase Cloud Functions)
Requirements: Firebase **Blaze (pay-as-you-go) plan** (Cloud Functions cannot be deployed on the free Spark plan; typical shop volume stays inside the free allowance), Node.js 20 and the Firebase CLI on your computer.
```
npm install -g firebase-tools
firebase login            # use thechocolatestory.ind@gmail.com
cd <this project folder>  # the folder containing firebase.json
cd functions && npm install && cd ..
firebase deploy --only functions
```
After deploy the function is at `https://asia-south1-the-chocolate-story.cloudfunctions.net/api` (already set in `common.js`). If the CLI prints a different URL, put that in `BACKEND_CONFIG.baseUrl`.
- **Allowed websites (CORS):** `https://thechocolatestory.in` and `https://www.thechocolatestory.in`. To allow another origin set the environment variable `EXTRA_ORIGINS` (comma-separated) for the function.
- The function uses the project's own service identity: **no key file, no secret and no password is needed or stored anywhere.**
- Deploy the function BEFORE publishing the storefront, otherwise checkout will show "We couldn't reach the server".
- The backend creates a `counters` collection (`orders-<year>`) for sequential order numbers such as `TCS-2026-0001`. Clients cannot read or write it (default-deny rules).
- Firestore **security rules are unchanged**. Orders are created by the Admin SDK, which is the secure way to do it under the existing rules.
- `functions/` is source code only. You may keep it out of the public GitHub Pages repository and deploy from a private copy if you prefer.

### Things the owner / admin project must know (not changed in this update)
1. **Stock is not reduced automatically.** The backend only checks availability when an order is placed. Adjust stock in the admin panel when you confirm an order. (Unverified orders must not lock stock.)
2. **`paymentStatus` stays `"pending"` in the database.** Under the current rules the admin can change only `status`, `updatedAt` and `adminNote`. The customer page therefore treats any confirmed/shipped/delivered order as "Payment verified". If you want the admin to record `paymentStatus: "paid"`, the rules and the admin panel must be extended.
3. **Status path:** the current rules/admin allow `confirmed → processing → shipped` (not directly `confirmed → shipped`). Use the "processing" step, or relax `validOrderTransition` in the rules yourself.
4. Old orders created with `paymentMethod: "razorpay"` still display normally.
5. Reviews: the review submission form stays disabled because no review endpoint exists yet (`BACKEND_CONFIG.enabled`).

## 8. Business rules the site states to customers
100% eggless · PAN India delivery · payment by UPI only (no Cash on Delivery) · an order is confirmed only after admin verifies the payment · delivery usually around 6–8 days (an estimate, never a guarantee) · each product's `deliveryCharge` is applied **once per product** · cancellation only before shipping.

## 9. Owner checklist
1. Deploy the backend (section 7) and make sure the Blaze plan is on.
2. Keep the merchant UPI ID in `upi.js` correct (`kirti07kkapoor@okhdfcbank`).
3. Keep `thechocolatestory.in` (and `www`) in Firebase Authentication → Authorized domains.
4. Optional: `float.png` for the floating custom-order button (`FLOAT_IMAGE_FILE` in `home.js`).

## 10. Verification status
Tested in headless Chromium (320/390/1280 px) with a mock Firestore and a mock backend: checkout → order creation request (no prices sent) → UPI link fields and amount → Confirm Purchase popup copy → WhatsApp message → error paths and double-click protection; tracking for every status, cancellation visibility, shipment display without fake tracking; all 19 pages for console errors/overflow/headings; cart, shop, wishlist, addresses and profile flows. The backend logic was tested with 66 automated checks against an in-memory Firestore (pricing, delivery, options, stock, tampering, idempotency, auth, cancellation, CORS).
**NOT tested (needs your deployment or devices):** the deployed Cloud Function against your real Firestore; Google sign-in on the live domain; a real UPI app (the chooser behaves differently across Android/iOS/desktop); a real WhatsApp device; the Firestore index behaviour of the idempotency query (if Firebase asks for an index, open the link in the function log and create it).

## 11. Troubleshooting
- *Google sign-in popup fails:* domain missing from Firebase Authorized domains, or pop-ups blocked (the site falls back to redirect).
- *Blank sections on the homepage:* the collection is empty or has no `isActive: true` documents — the site hides empty sections by design.
- *"Missing or insufficient permissions" in the console:* the document isn't active/owned by the signed-in user (rules are deliberately strict).
- *Old version still showing:* accept the "Refresh" prompt, or hard-reload; bump `VERSION` in `sw.js` when you publish.
