#!/usr/bin/env node
// generate-seo.mjs — rebuilds the static SEO pages, sitemap.xml from the CURRENT public catalogue. Run it from the storefront folder
// whenever products or categories are added/renamed/re-priced, then commit the generated files:
//     node generate-seo.mjs                      (reads active products/categories from Firestore's public REST API; Node 18+)
//     node generate-seo.mjs --backup file.json   (reads a Firestore export instead; offline)
// It writes product-<slug>.html, shop-<slug>.html and sitemap.xml. It only READS data the storefront rules already make public
// (isActive == true), uses the public web API key already shipped in firebase.js, and never writes to Firestore.
import fs from "node:fs";

const SITE = "https://thechocolatestory.in", BRAND = "The Chocolate Story", PROJECT = "the-chocolate-story";
const API_KEY = (fs.readFileSync("firebase.js", "utf8").match(/apiKey:\s*"([^"]+)"/) || [])[1];
const DEFAULT_IMG = SITE + "/social-preview.jpg", DEFAULT_ALT = BRAND + " logo";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); if (s.length <= n) return s; const c = s.slice(0, n - 1); return c.slice(0, c.lastIndexOf(" ") > 60 ? c.lastIndexOf(" ") : n - 1).replace(/[\s,;:.-]+$/, "") + "…"; };
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

/* ---------- data ---------- */
function decode(v) {
  if ("stringValue" in v) return v.stringValue; if ("integerValue" in v) return Number(v.integerValue); if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue; if ("timestampValue" in v) return v.timestampValue; if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  return null;
}
async function liveCollection(name) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: name }], where: { fieldFilter: { field: { fieldPath: "isActive" }, op: "EQUAL", value: { booleanValue: true } } } } })
  });
  if (!res.ok) throw new Error(`Firestore ${name}: HTTP ${res.status}`);
  return (await res.json()).filter(r => r.document).map(r => ({ id: r.document.name.split("/").pop(), ...Object.fromEntries(Object.entries(r.document.fields || {}).map(([k, v]) => [k, decode(v)])) }));
}
function backupCollection(file, name) {
  const c = JSON.parse(fs.readFileSync(file, "utf8")).collections.find(x => x.id === name);
  return (c ? c.documents : []).map(d => ({ id: d.id, ...d.fields })).filter(d => d.isActive === true);
}
const bi = process.argv.indexOf("--backup"), backup = bi > 0 ? process.argv[bi + 1] : "";
const products = (backup ? backupCollection(backup, "products") : await liveCollection("products")).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
const categories = (backup ? backupCollection(backup, "categories") : await liveCollection("categories")).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

/* ---------- helpers mirroring the storefront (common.js / cart.js) ---------- */
const purchasable = (p) => !(p.isActive !== true || p.isAvailable === false || (p.trackInventory === true && Number.isFinite(Number(p.stockQuantity)) && Number(p.stockQuantity) <= 0 && p.allowBackorder !== true));
const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };
function images(p) {
  const out = [], seen = new Set(), push = (u, alt) => { const h = httpsUrl(typeof u === "object" && u ? u.url : u); if (h && !seen.has(h)) { seen.add(h); out.push({ url: h, alt: (typeof u === "object" && u && u.alt) || alt || p.name }); } };
  push(p.primaryImage); (Array.isArray(p.images) ? p.images : []).slice().sort((a, b) => (a && a.sortOrder || 0) - (b && b.sortOrder || 0)).forEach(i => push(i)); return out;
}
const adj = (o) => { for (const k of ["priceAdjustment", "priceDelta", "extraPrice", "additionalPrice", "price"]) if (o && o[k] != null && o[k] !== "" && Number.isFinite(Number(o[k]))) return Number(o[k]); return 0; };
/** [lowest, highest] possible unit price for the product's options, same rules as the storefront's unitPrice(). */
function priceRange(p) {
  let lo = Number(p.basePrice), hi = lo;
  for (const g of Array.isArray(p.options) ? p.options : []) {
    const list = g && (g.choices || g.values || g.options || g.items), isText = ["text", "textarea", "input", "message", "custom"].includes(String(g && g.type || "").toLowerCase());
    if (isText) { const a = Math.max(0, adj(g)); hi += a; continue; }
    if (!Array.isArray(list)) continue;
    const prices = list.filter(c => !(c && typeof c === "object" && (c.isAvailable === false || c.available === false || c.isActive === false))).map(c => typeof c === "object" ? adj(c) : 0); if (!prices.length) continue;
    const required = g.required !== false;
    lo += required ? Math.min(...prices) : Math.min(0, ...prices); hi += required ? Math.max(...prices) : Math.max(0, ...prices);
  }
  return [lo, hi];
}
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

/* ---------- templates ---------- */
const STRIP = [/^<title>.*<\/title>\n?/m, /^<meta name="description"[^\n]*\n?/m, /^<meta name="robots"[^\n]*\n?/m, /^<link rel="canonical"[^\n]*\n?/m, /^<meta property="og:(title|description|type|url|image[^"]*|locale)"[^\n]*\n?/gm, /^<meta name="twitter:[^\n]*\n?/gm];
function head(tpl, { title, description, url, ogType, image, imageAlt, extra = "", ld = [] }) {
  let s = tpl; for (const r of STRIP) s = s.replace(r, "");
  const block = `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${url}">
<meta property="og:locale" content="en_IN">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(imageAlt)}">
${extra}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(imageAlt)}">
${ld.map(jsonLd).join("\n")}
`;
  if (!/<meta name="theme-color"[^\n]*\n/.test(s)) throw new Error("template head changed: theme-color line not found");
  return s.replace(/(<meta name="theme-color"[^\n]*\n)/, "$1" + block);
}
const breadcrumb = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })) });
const pageScript = (o) => `<script>window.__TCS_PAGE=${JSON.stringify(o).replace(/</g, "\\u003c")};</script>\n`;

const written = [], sitemap = [];
const productTpl = fs.readFileSync("product.html", "utf8").replace(/^<meta name="robots" content="noindex[^\n]*\n/m, ""), shopTpl = fs.readFileSync("shop.html", "utf8");
const catById = new Map(categories.map(c => [c.id, c]));
const catHasProducts = (c) => products.some(p => p.categoryId === c.id);
const catFile = (c) => SLUG.test(c.slug || "") && catHasProducts(c) ? `shop-${c.slug}.html` : "";
const latest = (...d) => d.filter(Boolean).map(x => new Date(x)).filter(x => !isNaN(x)).sort((a, b) => b - a)[0];

for (const p of products) {
  if (!SLUG.test(p.slug || "") || !p.name) { console.warn("skipped product without a valid slug/name:", p.id); continue; }
  const file = `product-${p.slug}.html`, url = `${SITE}/${file}`, imgs = images(p), cat = catById.get(p.categoryId), ok = purchasable(p);
  const seoTitle = String(p.seoTitle || p.name), title = /The Chocolate Story/i.test(seoTitle) ? seoTitle : `${seoTitle} | ${BRAND}`;
  const description = clip(p.seoDescription || p.shortDescription || p.description || `${p.name} from ${BRAND}.`, 200);
  const hasPrice = Number.isFinite(Number(p.basePrice)) && Number(p.basePrice) >= 0, [lo, hi] = hasPrice ? priceRange(p) : [0, 0];
  const availability = "https://schema.org/" + (ok ? "InStock" : "OutOfStock");
  const offer = !hasPrice ? undefined : (hi > lo ? { "@type": "AggregateOffer", url, priceCurrency: "INR", lowPrice: money(lo), highPrice: money(hi), availability, itemCondition: "https://schema.org/NewCondition" }
    : { "@type": "Offer", url, priceCurrency: "INR", price: money(lo), availability, itemCondition: "https://schema.org/NewCondition" });
  const product = { "@context": "https://schema.org", "@type": "Product", "@id": url + "#product", name: p.name, description: clip(p.description || p.shortDescription || description, 5000), url, sku: p.id,
    ...(imgs.length ? { image: imgs.slice(0, 5).map(i => i.url) } : {}), brand: { "@type": "Brand", name: BRAND }, ...(cat ? { category: cat.name } : {}), ...(offer ? { offers: offer } : {}) };
  // No aggregateRating/review: only added if real, valid review data is ever wired in. p.reviewCount/averageRating are not published here.
  const crumbs = [["Home", SITE + "/"], ["Shop", SITE + "/shop.html"], ...(cat && catFile(cat) ? [[cat.name, `${SITE}/${catFile(cat)}`]] : []), [p.name, url]];
  const extra = hasPrice ? `<meta property="product:price:amount" content="${money(lo)}">\n<meta property="product:price:currency" content="INR">\n<meta property="product:availability" content="${ok ? "in stock" : "out of stock"}">\n` : "";
  let html = head(productTpl, { title, description, url, ogType: "product", image: imgs[0] ? imgs[0].url : DEFAULT_IMG, imageAlt: imgs[0] ? imgs[0].alt : DEFAULT_ALT, extra, ld: [product, breadcrumb(crumbs)] });
  html = html.replace('<h1 class="visually-hidden" id="product-h1">Product details</h1>', `<h1 class="visually-hidden" id="product-h1">${esc(p.name)}</h1>`);
  html = html.replace('<div id="product-detail" aria-live="polite"></div>', `<div id="product-detail" aria-live="polite"><noscript><article><h2>${esc(p.name)}</h2>${imgs[0] ? `<img src="${esc(imgs[0].url)}" alt="${esc(imgs[0].alt)}" width="600" height="600">` : ""}<p>${esc(clip(p.description || p.shortDescription || "", 600))}</p>${hasPrice ? `<p>${hi > lo ? "From " : ""}₹${money(lo)}</p>` : ""}<p>${ok ? "Available to order — please enable JavaScript to add it to your cart." : "Currently unavailable."}</p></article></noscript></div>`);
  html = html.replace('<script type="module" src="common.js"></script>', pageScript({ type: "product", id: p.id, slug: p.slug }) + '<script type="module" src="common.js"></script>');
  fs.writeFileSync(file, html); written.push(file);
  sitemap.push({ loc: url, lastmod: latest(p.updatedAt, p.createdAt) });
}
for (const c of categories) {
  const file = catFile(c); if (!file) continue;
  const url = `${SITE}/${file}`, desc0 = String(c.description || "").trim().replace(/[.!?]*$/, ".");
  const description = clip(`${c.description ? desc0 + " " : ""}Browse and order ${String(c.name).toLowerCase()} online from ${BRAND}, with delivery across India.`, 200);
  const title = `${c.name} | ${BRAND}`, cimg = httpsUrl(c.imageURL);
  let html = head(shopTpl, { title, description, url, ogType: "website", image: cimg || DEFAULT_IMG, imageAlt: cimg ? `${c.name} from ${BRAND}` : DEFAULT_ALT,
    ld: [breadcrumb([["Home", SITE + "/"], ["Shop", SITE + "/shop.html"], [c.name, url]])] });
  html = html.replace(/<header class="page-head">[\s\S]*?<\/header>/, `<header class="page-head"><div class="container"><p class="crumbs"><a href="index.html">Home</a> / <a href="shop.html">Shop</a> / ${esc(c.name)}</p><h1>${esc(c.name)}</h1><p>${esc(c.description || "")}</p></div></header>`);
  html = html.replace('<script type="module" src="common.js"></script>', pageScript({ type: "category", slug: c.slug }) + '<script type="module" src="common.js"></script>');
  fs.writeFileSync(file, html); written.push(file);
  sitemap.push({ loc: url, lastmod: latest(c.updatedAt, ...products.filter(p => p.categoryId === c.id).map(p => p.updatedAt)) });
}

/* ---------- sitemap.xml (canonical, indexable URLs only; lastmod only where a real date exists) ---------- */
const staticPages = ["/", "/shop.html", "/about.html", "/contact.html", "/reviews.html", "/shipping-policy.html", "/cancellation-policy.html", "/return-refund-policy.html", "/privacy-policy.html", "/terms-and-conditions.html"].map(p => ({ loc: SITE + p }));
const all = [...staticPages, ...sitemap.sort((a, b) => a.loc.localeCompare(b.loc))];
const iso = (d) => d instanceof Date ? d.toISOString().slice(0, 10) : "";
fs.writeFileSync("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${all.map(u => `  <url><loc>${esc(u.loc)}</loc>${iso(u.lastmod) ? `<lastmod>${iso(u.lastmod)}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`);

// Remove snapshot pages of products/categories that are no longer active so stale pages don't linger.
for (const f of fs.readdirSync(".")) if (/^(product|shop)-[a-z0-9-]+\.html$/.test(f) && !written.includes(f)) { fs.unlinkSync(f); console.log("removed stale", f); }
console.log(`Wrote ${written.length} pages and sitemap.xml (${all.length} URLs).`);
