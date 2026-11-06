// shop.js — catalogue: live active products, category filter, search, sort, availability filter, URL-synced state.
// Queries are single-field `where("isActive","==",true)` (rules-compatible, no composite index); everything else is client-side.
import { db, collection, getDocs, query, where, limit } from "./firebase.js";
import { $, el, num, purchasable, productCard, renderError, renderEmpty } from "./common.js";
import { createWishlistController, wishHandler } from "./wishlist-reviews.js";

const slot = $("#shop-results");
const PAGE_SIZE = 24;
const SORTS = {
  featured: { label: "Featured", fn: (a, b) => (b.isFeatured === true) - (a.isFeatured === true) || num(a.sortOrder, 9999) - num(b.sortOrder, 9999) },
  newest: { label: "Newest first", fn: (a, b) => ms(b.createdAt) - ms(a.createdAt) },
  priceAsc: { label: "Price: low to high", fn: (a, b) => num(a.basePrice, Infinity) - num(b.basePrice, Infinity) },
  priceDesc: { label: "Price: high to low", fn: (a, b) => num(b.basePrice, -1) - num(a.basePrice, -1) },
  name: { label: "Name: A to Z", fn: (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "en", { sensitivity: "base" }) }
};
const ms = (v) => (v && typeof v.toMillis === "function") ? v.toMillis() : 0;
const fetchActive = async (name, extra = []) => (await getDocs(query(collection(db, name), where("isActive", "==", true), ...extra))).docs.map(d => ({ id: d.id, ...d.data() }));

function haystack(p) {
  return [p.name, p.shortDescription, p.description, ...(Array.isArray(p.tags) ? p.tags : []), ...(Array.isArray(p.searchKeywords) ? p.searchKeywords : [])]
    .filter(x => typeof x === "string").join(" ").toLowerCase();
}

async function boot() {
  slot.replaceChildren(el("div", { class: "skeleton-row", "aria-hidden": "true" }, Array.from({ length: 8 }, () => el("div", { class: "skeleton" }))));
  let products, cats;
  try { [products, cats] = await Promise.all([fetchActive("products", [limit(300)]), fetchActive("categories")]); }
  catch { return renderError(slot, "We couldn't load the shop right now. Please check your connection and try again.", boot); }
  cats.sort((a, b) => num(a.sortOrder, 9999) - num(b.sortOrder, 9999));
  const wish = await createWishlistController();
  const onWish = wishHandler(wish);

  const params = new URLSearchParams(location.search);
  const findCat = (v) => cats.find(c => c.id === v || c.slug === v);
  const initialCat = findCat(params.get("category") || "");
  const state = {
    category: initialCat ? initialCat.id : "", q: (params.get("q") || "").slice(0, 80),
    sort: SORTS[params.get("sort")] ? params.get("sort") : "featured", onlyAvailable: params.get("available") === "1", shown: PAGE_SIZE
  };
  const catNotFound = params.get("category") && !initialCat;

  const search = el("input", { type: "search", id: "shop-q", value: state.q, placeholder: "Search chocolates, cakes, gifts…", autocomplete: "off", maxlength: 80 });
  const sort = el("select", { id: "shop-sort" }, Object.entries(SORTS).map(([k, s]) => el("option", { value: k, selected: k === state.sort, text: s.label })));
  const avail = el("input", { type: "checkbox", id: "shop-avail", checked: state.onlyAvailable });
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Categories" });
  const count = el("p", { class: "shop-count", role: "status", "aria-live": "polite" });
  const results = el("div", {});
  const mkChip = (id, label, n) => el("button", { type: "button", class: "chip", "data-cat": id, "aria-pressed": String(state.category === id), onclick: () => { state.category = id; state.shown = PAGE_SIZE; update(); } }, label, n != null ? el("span", { class: "chip__n", text: String(n) }) : null);

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return products.filter(p => (!state.category || p.categoryId === state.category) && (!state.onlyAvailable || purchasable(p)) && (!q || haystack(p).includes(q))).sort(SORTS[state.sort].fn);
  }
  function syncUrl() {
    const u = new URLSearchParams();
    const cat = findCat(state.category);
    if (cat) u.set("category", cat.slug || cat.id);
    if (state.q.trim()) u.set("q", state.q.trim());
    if (state.sort !== "featured") u.set("sort", state.sort);
    if (state.onlyAvailable) u.set("available", "1");
    history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : ""));
  }
  function update() {
    chips.replaceChildren(mkChip("", "All", products.length), ...cats.filter(c => products.some(p => p.categoryId === c.id)).map(c => mkChip(c.id, c.name || "Category", products.filter(p => p.categoryId === c.id).length)));
    const list = filtered(), visible = list.slice(0, state.shown);
    count.textContent = list.length ? `${list.length} product${list.length === 1 ? "" : "s"}` : "No products found";
    if (!products.length) results.replaceChildren(emptyBox({ title: "Our shop is being stocked", text: "New products will appear here soon.", actionText: "Back to home", actionHref: "index.html" }));
    else if (!list.length) {
      const b = emptyBox({ title: "Nothing matches your filters", text: "Try a different search or clear the filters." });
      b.append(el("button", { type: "button", class: "btn btn--primary", onclick: () => { Object.assign(state, { category: "", q: "", onlyAvailable: false, shown: PAGE_SIZE }); search.value = ""; avail.checked = false; update(); } }, "Clear filters"));
      results.replaceChildren(b);
    } else {
      results.replaceChildren(...[el("ul", { class: "p-grid" }, visible.map(p => productCard(p, { saved: wish.has(p.id), onWish }))),
        list.length > visible.length ? el("div", { class: "more" }, el("button", { type: "button", class: "btn btn--ghost", onclick: () => { state.shown += PAGE_SIZE; update(); } }, `Show more (${list.length - visible.length} left)`)) : null].filter(Boolean));
    }
    syncUrl();
  }
  const emptyBox = (o) => { const d = el("div", {}); renderEmpty(d, o); return d.firstChild; };
  let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { state.q = search.value; state.shown = PAGE_SIZE; update(); }, 200); });
  sort.addEventListener("change", () => { state.sort = sort.value; update(); });
  avail.addEventListener("change", () => { state.onlyAvailable = avail.checked; state.shown = PAGE_SIZE; update(); });

  slot.replaceChildren(...[
    catNotFound ? el("p", { class: "shop-note", role: "status", text: "We couldn't find that category, so we're showing everything." }) : null,
    el("div", { class: "shop-toolbar" },
      el("div", { class: "field field--grow" }, el("label", { for: "shop-q", text: "Search" }), search),
      el("div", { class: "field" }, el("label", { for: "shop-sort", text: "Sort by" }), sort),
      el("label", { class: "check", for: "shop-avail" }, avail, el("span", { text: "Available only" }))),
    chips, count, results].filter(Boolean));
  update();
}
if (slot) boot();
