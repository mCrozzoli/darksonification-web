// Uncanny Listening — a pedal knob (SVG). Drag up / down or use the wheel to turn it, double-click to reset, arrow keys when focused.
// knob(el, {label, value, min, max, def, log, fmt, onInput, onChange}) → {set(v), get()}
const NS = "http://www.w3.org/2000/svg", A0 = -135, A1 = 135;
const polar = (a, r) => [24 + r * Math.sin(a * Math.PI / 180), 24 - r * Math.cos(a * Math.PI / 180)];
const arc = (a, b, r) => { const [x0, y0] = polar(a, r), [x1, y1] = polar(b, r); return `M${x0},${y0} A${r},${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x1},${y1}`; };
export function knob(el, o) {
  const { min = 0, max = 2, def = 1, log = false, fmt = (v) => v.toFixed(2) } = o;
  const toU = (v) => log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min), fromU = (u) => log ? min * Math.pow(max / min, u) : min + u * (max - min);
  let v = o.value ?? def;
  el.classList.add("knob"); el.tabIndex = 0; el.setAttribute("role", "slider");
  el.innerHTML = `<svg viewBox="0 0 48 48" width="48" height="48"><path class="kt" d="${arc(A0, A1, 18)}"/><path class="kv"/><line class="kp" x1="24" y1="24"/></svg><div class="kl"></div><div class="kn"></div>`;
  const pv = el.querySelector(".kv"), pp = el.querySelector(".kp"), kl = el.querySelector(".kl"), kn = el.querySelector(".kn");
  const paint = () => { const u = Math.max(0, Math.min(1, toU(v))), a = A0 + u * (A1 - A0), [x, y] = polar(a, 14);
    pv.setAttribute("d", u > 0.003 ? arc(A0, a, 18) : ""); pp.setAttribute("x2", x); pp.setAttribute("y2", y);
    kl.textContent = typeof o.label === "function" ? o.label() : o.label; kn.textContent = fmt(v);
    el.setAttribute("aria-valuenow", v); el.classList.toggle("off", v === 0 && !log); };
  const setU = (u, final) => { const nv = fromU(Math.max(0, Math.min(1, u))); if (nv === v && !final) return; v = nv; paint(); o.onInput && o.onInput(v); if (final) o.onChange && o.onChange(v); };
  let drag = null;
  el.addEventListener("pointerdown", (e) => { drag = { y: e.clientY, u: toU(v) }; el.setPointerCapture(e.pointerId); e.preventDefault(); });
  el.addEventListener("pointermove", (e) => { if (drag) setU(drag.u + (drag.y - e.clientY) / (e.shiftKey ? 600 : 150), false); });
  el.addEventListener("pointerup", () => { if (drag) { drag = null; o.onChange && o.onChange(v); } });
  el.addEventListener("wheel", (e) => { e.preventDefault(); setU(toU(v) - Math.sign(e.deltaY) * 0.025, true); }, { passive: false });
  el.addEventListener("dblclick", () => { v = def; paint(); o.onInput && o.onInput(v); o.onChange && o.onChange(v); });
  el.addEventListener("keydown", (e) => { const d = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0; if (d) { e.preventDefault(); setU(toU(v) + d * 0.025, true); } });
  paint();
  return { set(nv) { v = nv; paint(); }, get: () => v, repaint: paint };
}
