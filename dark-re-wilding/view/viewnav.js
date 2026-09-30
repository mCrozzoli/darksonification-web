/* viewnav.js — dark_re_wilding top VIEW switcher.
 * Renders the six views as a button group with the CURRENT view lit, so you can
 * always see where you are. Each page just needs an empty <nav id="viewnav"></nav>
 * in its header; this fills it and highlights based on the filename. */
(function () {
  const VIEWS = [
    ["index.html", "scatter"], ["rose.html", "roses"], ["biplot.html", "biplot"],
    ["linear.html", "linear"], ["spectro.html", "spectro"], ["mfcc.html", "mfcc"],
  ];
  const here = (location.pathname.split("/").pop() || "index.html") || "index.html";
  const CSS = `
    #viewnav{ display:flex; gap:4px; align-items:center; flex-wrap:wrap; }
    .vnav{ font:inherit; font-size:12px; padding:3px 10px; border-radius:6px; text-decoration:none;
      color:var(--dim,#67708c); border:1px solid transparent; cursor:pointer; white-space:nowrap; }
    a.vnav:hover{ color:var(--txt,#c8d0ee); border-color:var(--rw-ctl-line); }
    .vnav.here{ color:var(--cur,#fff1a8); border-color:var(--rw-gold-line); background:var(--rw-ctl); cursor:default; }`;

  function build() {
    const host = document.getElementById("viewnav");
    if (!host) return;
    host.innerHTML = VIEWS.map(([f, label]) => {
      const cur = (f === here) || (here === "" && f === "index.html");
      return cur ? `<span class="vnav here" aria-current="page">${label}</span>`
                 : `<a class="vnav" href="${f}">${label}</a>`;
    }).join("");
  }
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  if (document.readyState !== "loading") build();
  else document.addEventListener("DOMContentLoaded", build);
})();
