// dark_svartsengi · views/latent.js — view C, the latent map of sound types (DESIGN §5 C). W3.
//
// Reads viz/data/latent/<NET.STA.LOC>_f1m.json = {x[], y[], t[], cluster[], anomaly[], method, features[]}: one point per
// recorded minute. Coloured by cluster, ringed where anomalous. The minutes inside the timeline's window stand out, the
// rest recede toward the ground; the cursor's minute is ringed in gold (you). Click a point = jump the timeline to that
// minute and play its Ground (the evidence). The clusters are unsupervised: they are named by when they happen
// (from the data), never by what we think they are.
window.SvkLatent = (function () {
  "use strict";
  const fmt = d3.utcFormat("%H:%M");
  const fmtD = d3.utcFormat("%-d %b %Y %H:%M");

  function create(host, ctx) {
    const { S } = ctx;
    host.classList.add("latv");
    host.innerHTML = `<canvas class="lat-cv"></canvas><div class="lat-key"></div><div class="lat-ax lat-axx"></div><div class="lat-ax lat-axy"></div>
      <div class="lat-empty"></div><div class="hbox lat-hbox"></div>`;
    const cv = host.querySelector(".lat-cv"), g = cv.getContext("2d"), hbox = host.querySelector(".lat-hbox");
    let W = 200, H = 160, dpr = 1, L = null, dirty = true, sx = null, sy = null, groups = [];

    function resize() {
      const r = host.getBoundingClientRect();
      W = Math.max(160, r.width); H = Math.max(120, r.height); dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
      scales(); dirty = true;
    }
    function scales() {
      if (!L) return;
      const pad = 22, xe = d3.extent(L.x), ye = d3.extent(L.y);
      sx = d3.scaleLinear().domain(xe).nice().range([pad, W - 10]);
      sy = d3.scaleLinear().domain(ye).nice().range([H - pad, 26]);
    }
    async function load() {
      const sta = ctx.seismic();
      L = sta ? await ctx.src.latent(sta.id) : null;
      const empty = host.querySelector(".lat-empty");
      if (!L || !L.x || !L.x.length) { empty.textContent = "no latent map yet: it needs recorded minutes (only MELH, 14 Jan 2024, exists)"; return; }
      empty.textContent = "";
      // each cluster named by when it mostly happens (the central 80% of its minutes), from the data
      const ids = [...new Set(L.cluster)].sort((a, b) => a - b);
      groups = ids.map((c) => {
        const ts = L.t.filter((_, i) => L.cluster[i] === c).sort((a, b) => a - b);
        const q = (p) => ts[Math.min(ts.length - 1, Math.floor(p * ts.length))];
        const meta = (L.clusters || []).find((k) => k.id === c) || {};
        const share = meta.share_in_phase && meta.label_hint ? meta.share_in_phase[meta.label_hint] : null;
        return { c, n: ts.length, from: q(0.1), to: q(0.9), hint: meta.label_hint || null, share };
      });
      const ev = L.explained_variance || L.explained || [];
      host.querySelector(".lat-axx").textContent = `${(L.method || "").toUpperCase()} 1${ev[0] ? ` · ${Math.round(ev[0] * 100)}%` : ""}`;
      host.querySelector(".lat-axy").textContent = `${(L.method || "").toUpperCase()} 2${ev[1] ? ` · ${Math.round(ev[1] * 100)}%` : ""}`;
      key(); scales(); dirty = true;
    }
    function key() {
      const C = ctx.col();
      host.querySelector(".lat-key").innerHTML = groups.map((gp) =>
        `<span class="lk" title="mostly ${fmt(new Date(gp.from * 1000))}–${fmt(new Date(gp.to * 1000))} UTC · ${gp.n} minutes${gp.hint ? ` · the pipeline's hint: “${gp.hint}”, ${Math.round((gp.share || 0) * 100)}% of its minutes fall in that window of FINDINGS F2` : ""}"><span class="sw" style="background:${C.clusters[gp.c % C.clusters.length]}"></span>group ${gp.c + 1}${gp.hint ? ` · ${gp.hint}?` : ""}</span>`).join("")
        + `<span class="lk"><span class="sw ring"></span>unusual</span>`;
    }
    function draw() {
      if (!dirty || !L || !sx) return; dirty = false;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const C = ctx.col(), [t0, t1] = S.view;
      // grid
      g.strokeStyle = ctx.tok("--ds-axis"); g.lineWidth = 1;
      g.beginPath(); g.moveTo(sx(0), 20); g.lineTo(sx(0), H - 18); g.moveTo(16, sy(0)); g.lineTo(W - 8, sy(0)); g.stroke();
      const inWin = (t) => t + 60 > t0 && t < t1;
      for (const pass of [0, 1]) {
        for (let i = 0; i < L.x.length; i++) {
          const on = inWin(L.t[i]);
          if ((pass === 1) !== on) continue;
          const col = C.clusters[L.cluster[i] % C.clusters.length];
          g.globalAlpha = on ? 0.95 : 0.22;
          g.fillStyle = col; g.beginPath(); g.arc(sx(L.x[i]), sy(L.y[i]), on ? 3.2 : 2.2, 0, 7); g.fill();
          if (L.anomaly[i]) { g.strokeStyle = ctx.tok("--ds-txt"); g.lineWidth = 1; g.globalAlpha = on ? 0.9 : 0.3; g.beginPath(); g.arc(sx(L.x[i]), sy(L.y[i]), 5.5, 0, 7); g.stroke(); }
        }
      }
      g.globalAlpha = 1;
      // traced moments: their minutes ringed in the trace's colour (re_wilding 3.10)
      const TR = (ctx.traces && ctx.traces()) || [];
      if (TR.length) {
        g.lineWidth = 1.6;
        for (const r of TR) { g.strokeStyle = r.color; for (let i = 0; i < L.t.length; i++) if (L.t[i] + 60 > r.t0 && L.t[i] < r.t1) { g.beginPath(); g.arc(sx(L.x[i]), sy(L.y[i]), 6.5, 0, 7); g.stroke(); } }
      }
      // the cursor's minute (gold = you)
      const k = nearestT(S.cursor);
      if (k >= 0 && Math.abs(L.t[k] + 30 - S.cursor) <= 60) {
        g.strokeStyle = ctx.tok("--ds-cur"); g.lineWidth = 2; g.beginPath(); g.arc(sx(L.x[k]), sy(L.y[k]), 8, 0, 7); g.stroke();
      }
    }
    function nearestT(t) {
      if (!L) return -1;
      let lo = 0, hi = L.t.length - 1;
      if (t <= L.t[0]) return 0; if (t >= L.t[hi]) return hi;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L.t[m] <= t) lo = m; else hi = m; }
      return t - L.t[lo] < L.t[hi] - t ? lo : hi;
    }
    function pick(px, py) {
      if (!L || !sx) return -1;
      let best = -1, bd = 100;
      for (let i = 0; i < L.x.length; i++) { const d = (sx(L.x[i]) - px) ** 2 + (sy(L.y[i]) - py) ** 2; if (d < bd) { bd = d; best = i; } }
      return best;
    }
    cv.addEventListener("pointermove", (e) => {
      if (ctx.hoverOn && !ctx.hoverOn()) { hbox.style.display = "none"; return; }
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, i = pick(px, py);
      if (i < 0) { hbox.style.display = "none"; return; }
      const gp = groups.find((q) => q.c === L.cluster[i]);
      hbox.innerHTML = [`<b>${fmtD(new Date(L.t[i] * 1000))} UTC</b> · one minute`,
        `group ${L.cluster[i] + 1}${gp ? ` (mostly ${fmt(new Date(gp.from * 1000))}–${fmt(new Date(gp.to * 1000))}${gp.hint ? `; hint “${gp.hint}”` : ""})` : ""}${L.anomaly[i] ? " · unusual" + (L.anomaly_score ? ` (score ${L.anomaly_score[i].toFixed(2)})` : "") : ""}`,
        ...((ctx.traces && ctx.traces()) || []).filter((r) => L.t[i] + 60 > r.t0 && L.t[i] < r.t1).map((r) => `<span style="color:${r.color}">◎ traced</span> · ${r.label}`),
        `<span class="dim">click: go to this minute and hear its ground motion · shift-click: trace it</span>`].map((l) => `<div>${l}</div>`).join("");
      hbox.style.display = "block";
      const bw = hbox.offsetWidth, bh = hbox.offsetHeight;
      hbox.style.left = Math.max(2, px + 14 + bw > W ? px - bw - 14 : px + 14) + "px";
      hbox.style.top = Math.max(2, py + 14 + bh > H ? py - bh - 14 : py + 14) + "px";
    });
    cv.addEventListener("pointerleave", () => (hbox.style.display = "none"));
    cv.addEventListener("click", (e) => {
      const r = cv.getBoundingClientRect(), i = pick(e.clientX - r.left, e.clientY - r.top);
      if (i >= 0 && e.shiftKey && ctx.traceAt) { ctx.traceAt(L.t[i] + 30, 0); return; }
      if (i >= 0) ctx.jumpToMinute(L.t[i]);
    });

    new ResizeObserver(() => resize()).observe(host);
    resize(); load();
    return { redraw() { dirty = true; }, frame() { draw(); }, restyle() { key(); dirty = true; }, reload: load, data: () => L };
  }
  return { create };
})();
