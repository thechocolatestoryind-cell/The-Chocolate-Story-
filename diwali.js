// diwali.js — Diwali entry splash, firework canvas and soft pointer-parallax for the festive hero. Purely decorative: it never touches
// products, cart, checkout or any data. Respects reduced-motion, pauses off-screen / in background tabs, and skips the splash for crawlers.
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
const release = () => root.classList.remove("dw-hold");

/* ---- splash (once per browser session) ---- */
function splash() {
  return new Promise((resolve) => {
    if (reduce || !root.classList.contains("dw-hold")) { release(); return resolve(); }
    try { sessionStorage.setItem("tcs_dw_intro", "1"); } catch { /* ignore */ }
    const o = document.createElement("div");
    o.className = "dw-intro"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Happy Diwali");
    o.innerHTML = `<div class="dw-intro__glow"></div><div class="dw-intro__box">
      <svg class="dw-intro__diya" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
        <g class="dw-intro__flame"><path d="M60 4c12 15 15 28 0 44-15-16-12-29 0-44z" fill="#E1B797"/><path d="M60 20c6 8 8 15 0 24-8-9-6-16 0-24z" fill="#FBF6F0"/></g>
        <path d="M6 52h108c0 26-24 44-54 44S6 78 6 52z" fill="#C9916D"/><path d="M6 52h108" stroke="#E1B797" stroke-width="3"/>
        <path d="M26 64c20 10 48 10 68 0" fill="none" stroke="#9D6F51" stroke-width="3" stroke-linecap="round"/></svg>
      <p class="dw-intro__title">Shubh Deepavali</p><p class="dw-intro__sub">The Chocolate Story</p></div>
      <button type="button" class="dw-intro__skip">Skip</button>`;
    document.body.append(o); document.body.classList.add("no-scroll");
    const skip = o.querySelector(".dw-intro__skip"); skip.focus({ preventScroll: true });
    let done = false, timer = 0;
    const onKey = (e) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); finish(); } };
    function finish() {
      if (done) return; done = true; clearTimeout(timer); document.removeEventListener("keydown", onKey);
      o.classList.add("is-out"); release(); document.body.classList.remove("no-scroll");
      setTimeout(() => { o.remove(); resolve(); }, 900);
    }
    timer = setTimeout(finish, 3200);
    o.addEventListener("click", finish); document.addEventListener("keydown", onKey);
  });
}

/* ---- fireworks (canvas, behind the text) ---- */
function fireworks() {
  const host = document.querySelector(".fest"), cv = host && host.querySelector(".fest__fx");
  if (!cv || reduce || !cv.getContext) return () => {};
  const ctx = cv.getContext("2d"), COLORS = ["#E1B797", "#C9916D", "#FBF6F0", "#F3E4D6"];
  let w = 0, h = 0, parts = [], rockets = [], running = false, onScreen = true, last = 0, next = 0;
  const wide = () => w > 900;
  function size() {
    const r = host.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, r.width > 900 ? 2 : 1.5);
    w = r.width; h = r.height; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function burst(x, y) {
    const n = wide() ? 76 : 40, a = COLORS[(Math.random() * COLORS.length) | 0], b = COLORS[(Math.random() * COLORS.length) | 0], k = wide() ? 1.15 : .8;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + Math.random() * .12, sp = (1.1 + Math.random() * 2.7) * k;
      parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, decay: .008 + Math.random() * .011, c: i % 3 ? a : b });
    }
  }
  const rocket = () => rockets.push({ x: w * (.12 + Math.random() * .76), y: h, ty: h * (.1 + Math.random() * .32), vy: -(5 + Math.random() * 2.2) });
  function frame(t) {
    if (!running) return; requestAnimationFrame(frame);
    const dt = Math.min(2.2, (t - last) / 16.7 || 1); last = t;
    if (!parts.length && !rockets.length) ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "rgba(0,0,0,.2)"; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    if (t > next) { rocket(); next = t + (wide() ? 1000 : 1700) + Math.random() * 1500; }
    ctx.fillStyle = "#FBF6F0";
    rockets = rockets.filter((r) => { r.y += r.vy * dt; ctx.fillRect(r.x, r.y, 2, 7); if (r.y <= r.ty) { burst(r.x, r.y); return false; } return true; });
    parts = parts.filter((p) => {
      p.vy += .034 * dt; p.vx *= .985; p.vy *= .985; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= p.decay * dt;
      if (p.life <= 0) return false; ctx.globalAlpha = p.life; ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 6.283); ctx.fill(); return true;
    });
    ctx.globalAlpha = 1;
  }
  const sync = () => { const go = onScreen && !document.hidden; if (go && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); } else if (!go && running) { running = false; parts = []; rockets = []; ctx.clearRect(0, 0, w, h); } };
  size(); let rz = 0; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(size, 150); });
  new IntersectionObserver((e) => { onScreen = e[0].isIntersecting; sync(); }).observe(host);
  document.addEventListener("visibilitychange", sync); sync();
  return (x, y) => burst(x ?? w / 2, y ?? h * .3);
}

/* ---- soft parallax on desktop pointers ---- */
function parallax() {
  const host = document.querySelector(".fest");
  if (!host || reduce || !matchMedia("(hover:hover) and (pointer:fine)").matches) return;
  const layers = [...host.querySelectorAll("[data-depth]")]; let raf = 0, mx = 0, my = 0;
  const apply = () => { raf = 0; layers.forEach((l) => { const d = +l.dataset.depth; l.style.setProperty("--px", (mx * d).toFixed(1) + "px"); l.style.setProperty("--py", (my * d).toFixed(1) + "px"); }); };
  host.addEventListener("pointermove", (e) => { const r = host.getBoundingClientRect(); mx = (e.clientX - r.left) / r.width - .5; my = (e.clientY - r.top) / r.height - .5; if (!raf) raf = requestAnimationFrame(apply); });
  host.addEventListener("pointerleave", () => { mx = my = 0; if (!raf) raf = requestAnimationFrame(apply); });
}

const celebrate = fireworks(); parallax();
splash().then(() => { release(); celebrate(); });
