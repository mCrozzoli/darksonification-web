// Uncanny Listening — descriptor comparison (brief §4.4): for every descriptor, its distribution per class and the effect
// size, ranked; the evidence behind "flux matters". Two classes: Cohen's d = (mean₂ − mean₁) / pooled SD (n − 1), the
// second class (by name) minus the first; more classes: η² (between-class share of the variance). Songs (L0) or 10 s
// segments (L1, each with its song's label). Clicking a descriptor proposes a map pair that uses it.
// effects(values[][], labels, K) → [{col, d | eta2, means, sds, n}] ; drawCompare(root, ctx) → {update()}
const d3 = window.d3;
export function effect(v, y, K) {
  const n = new Array(K).fill(0), mu = new Array(K).fill(0), ss = new Array(K).fill(0);
  v.forEach((x, i) => { n[y[i]]++; mu[y[i]] += x; }); for (let c = 0; c < K; c++) mu[c] /= n[c] || 1;
  v.forEach((x, i) => { ss[y[i]] += (x - mu[y[i]]) ** 2; });
  const sds = ss.map((s, c) => Math.sqrt(s / Math.max(1, n[c] - 1)));
  const gm = v.reduce((a, b) => a + b, 0) / v.length; let tot = 0; for (const x of v) tot += (x - gm) ** 2;
  let bet = 0; for (let c = 0; c < K; c++) bet += n[c] * (mu[c] - gm) ** 2;
  const r = { means: mu, sds, n, eta2: tot > 0 ? bet / tot : 0 };
  if (K === 2) { const sp = Math.sqrt(((n[0] - 1) * sds[0] ** 2 + (n[1] - 1) * sds[1] ** 2) / Math.max(1, n[0] + n[1] - 2)); r.d = sp > 0 ? (mu[1] - mu[0]) / sp : 0; }
  return r;
}
export function drawCompare(root, ctx) {
  // ctx: {cols, famLabel(col), rows() → [{v: {col: value}, y}], K, classes, colours, onPick(col), level, strings}
  const data = ctx.rows(), K = ctx.K, y = data.map((r) => r.y);
  const res = ctx.cols.map((col) => { const v = data.map((r) => r.v[col]); let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
    return { col, lo, hi, v, ...effect(v, y, K) }; }).filter((r) => r.hi > r.lo);
  const key = (r) => K === 2 ? Math.abs(r.d) : r.eta2;
  res.sort((a, b) => key(b) - key(a));
  const max = Math.max(1e-9, ...res.map(key));
  root.innerHTML = `<table class="cmp"><thead><tr><th></th><th class="k">${ctx.strings.descriptor}</th><th class="k">${K === 2 ? `d (${ctx.classes[1]} − ${ctx.classes[0]})` : "η²"}</th><th class="k">${ctx.strings.per_class}</th></tr></thead><tbody></tbody></table>`;
  const tb = root.querySelector("tbody");
  res.forEach((r, i) => {
    const tr = document.createElement("tr"); tr.dataset.col = r.col; tr.title = ctx.strings.pick;
    const ef = K === 2 ? r.d : r.eta2, w = 100 * Math.abs(key(r)) / max;
    tr.innerHTML = `<td class="k">${i + 1}</td><td><b>${ctx.famLabel(r.col)}</b> <span class="k">${r.col}</span></td>
      <td class="ef"><span class="bar ${ef < 0 ? "neg" : ""}" style="width:${w.toFixed(1)}%"></span><span>${ef >= 0 && K === 2 ? "+" : ""}${ef.toFixed(2)}</span></td><td class="dist"></td>`;
    tr.onclick = () => ctx.onPick(r.col, res);
    tb.appendChild(tr);
    // the distribution per class: one row of dots per class, its mean as a tick
    const W = 230, H = 10 + 9 * K, svg = d3.select(tr.querySelector(".dist")).append("svg").attr("width", W).attr("height", H), x = d3.scaleLinear().domain([r.lo, r.hi]).range([4, W - 4]);
    for (let c = 0; c < K; c++) {
      const yy = 6 + 9 * c, g = svg.append("g");
      r.v.forEach((v, j) => { if (y[j] === c) g.append("circle").attr("cx", x(v)).attr("cy", yy + (((j * 7919) % 5) - 2) * 0.8).attr("r", 1.3).attr("fill", ctx.colours[c]).attr("opacity", ctx.level === "l1" ? 0.18 : 0.55); });
      g.append("line").attr("class", "meanmark").attr("x1", x(r.means[c])).attr("x2", x(r.means[c])).attr("y1", yy - 4).attr("y2", yy + 4).attr("stroke", ctx.colours[c]);
    }
  });
  return { results: res };
}
