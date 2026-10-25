// dark_svartsengi · stations.js — the station positions (CONTRACT 0.13 §4.2 amendment) and the config dock's STATIONS. W3.
//
// Each station carries pos_status (measured | approx), pos_source and pos_err_m. An approx position is a placeholder: the
// map draws it hollow and dashed with a ring of its stated uncertainty, the about popover lists it, and the sound uses
// lat/lon the same either way. The older `pending` flag equals pos_status == "approx"; a station without numbers is
// listed, never placed.
//
// The config dock edits page-local OVERRIDES (CONTRACT 0.13, "Config panel"): typed in the table or read from a pasted or
// uploaded StationXML (parsed here, in the browser), applied live, saved as stations_override.json (download or copy)
// with pos_source "edited in the page". localStorage keeps them for this viewer only, a convenience; the published data
// (viz/data) is never written. Desktop and web alike: the file is downloaded, the bridge is never asked to write.
window.SvkStations = (function () {
  "use strict";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const EDITED = "edited in the page";
  const M_PER_DEG = 111320;

  // ------------------------------------------------------------------------------------------------ StationXML
  // FDSN StationXML (any namespace version): Network > Station > Channel, each with Latitude / Longitude / Elevation
  // (Channel also Depth). A Latitude's plusError / minusError (degrees) becomes pos_err_m when given.
  function parseStationXML(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("this is not well-formed XML");
    const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
    const num = (el, name) => {
      const c = kids(el, name)[0]; if (!c) return { v: null, err: null };
      const v = parseFloat(c.textContent), pe = parseFloat(c.getAttribute("plusError")), me = parseFloat(c.getAttribute("minusError"));
      return { v: isNum(v) ? v : null, err: isNum(pe) || isNum(me) ? Math.max(Math.abs(pe) || 0, Math.abs(me) || 0) : null };
    };
    const out = [], nets = [...doc.getElementsByTagNameNS("*", "Network")];
    if (!nets.length && !doc.getElementsByTagNameNS("*", "Station").length) throw new Error("no <Network> or <Station> in it: is it StationXML?");
    for (const net of nets.length ? nets : [doc.documentElement]) {
      const nc = net.getAttribute("code") || "";
      for (const sta of kids(net, "Station")) {
        const la = num(sta, "Latitude"), lo = num(sta, "Longitude"), el = num(sta, "Elevation");
        const site = kids(sta, "Site")[0], siteName = site ? (kids(site, "Name")[0] || site).textContent.trim() : "";
        const chans = kids(sta, "Channel").map((ch) => ({ code: ch.getAttribute("code") || "", loc: ch.getAttribute("locationCode") || "",
          lat: num(ch, "Latitude").v, lon: num(ch, "Longitude").v, elev: num(ch, "Elevation").v, depth: num(ch, "Depth").v,
          start: ch.getAttribute("startDate"), end: ch.getAttribute("endDate") }));
        const errDeg = Math.max(la.err || 0, lo.err || 0);
        out.push({ net: nc, sta: sta.getAttribute("code") || "", lat: la.v, lon: lo.v, elev: el.v, err_m: errDeg > 0 ? Math.round(errDeg * M_PER_DEG) : null,
                   start: sta.getAttribute("startDate"), end: sta.getAttribute("endDate"), site: siteName, chans });
      }
    }
    return out;
  }
  // our id → the parts StationXML names: "RK.MELH.10" = network RK, station MELH, location 10; "SKSH" = station only
  function idParts(id) { const p = String(id).split("."); return p.length >= 2 ? { net: p[0], sta: p[1], loc: p[2] ?? null } : { net: null, sta: p[0], loc: null }; }
  // the best StationXML entry for one of our stations: the station code must match; a network that differs is offered,
  // unticked, with a warning (8F.MELH, 2020–21, is not RK.MELH.10); among epochs, the one that covers our data, else the latest
  function matchXML(st, entries) {
    const want = idParts(st.id), cand = entries.filter((e) => e.sta === want.sta && isNum(e.lat) && isNum(e.lon));
    if (!cand.length) return null;
    const t = st.coverage && st.coverage[0] ? st.coverage[0][0] : st.first_day ? Date.parse(st.first_day + "T00:00:00Z") / 1000 : null;
    const covers = (e) => t != null && (!e.start || Date.parse(e.start) / 1000 <= t) && (!e.end || Date.parse(e.end) / 1000 >= t);
    const score = (e) => (want.net && e.net === want.net ? 4 : 0) + (covers(e) ? 2 : 0) + (e.start ? Date.parse(e.start) / 1e13 : 0);
    const e = cand.sort((a, b) => score(b) - score(a))[0];
    // the sensor's own position when its channels (our location code) carry one, else the station's
    const ch = e.chans.filter((c) => (want.loc == null || c.loc === want.loc) && isNum(c.lat) && isNum(c.lon));
    const useCh = ch.length > 0 && ch.every((c) => Math.abs(c.lat - ch[0].lat) < 1e-6 && Math.abs(c.lon - ch[0].lon) < 1e-6);
    const warn = [];
    if (want.net && e.net !== want.net) warn.push(`network ${e.net}, not ${want.net}`);
    if (t != null && !covers(e)) warn.push(`epoch ${(e.start || "?").slice(0, 10)} to ${(e.end || "open").slice(0, 10)} does not cover the data`);
    return { e, lat: useCh ? ch[0].lat : e.lat, lon: useCh ? ch[0].lon : e.lon, elev: useCh && isNum(ch[0].elev) ? ch[0].elev : e.elev,
             from: useCh ? `channel ${ch.map((c) => c.code).join(",")}${want.loc != null ? ` (location ${want.loc})` : ""}` : "station", warn, ok: !warn.length };
  }

  // a source in a few words (Miguel, 2026-10-25: calm, not walls of text); the full text goes in a title. "IMO GNSS browser",
  // "IMO site log", "placeholder: 2020-21 8F.MELH 'Melholl' site, ±2 km", "edited here · StationXML"
  function shortSource(s) {
    let t = String((s && s.pos_source) || "").trim();
    if (!t) return s && !s.placed ? "no position yet" : "";
    if (/^edited in the page/.test(t)) t = /StationXML/.test(t) ? "edited here · StationXML" : "edited here";
    else {
      t = t.split(/;\s|,\s(?:assumed|i\.e\.)/)[0].replace(/\([^)]*\)/g, "").replace(/https?:\/\/\S+/g, "")
           .replace(/\bstation list\b/i, "").replace(/\bthe\s+/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([:,.])/g, "$1").replace(/[:,]\s*$/, "").trim();
      if (t.length > 46) t = t.slice(0, 45).replace(/\s+\S*$/, "") + "…";
    }
    if (s && s.approx && isNum(s.pos_err_m) && s.pos_err_m > 0) t += `, ±${s.pos_err_m >= 1000 ? +(s.pos_err_m / 1000).toFixed(1) + " km" : Math.round(s.pos_err_m) + " m"}`;
    return t;
  }

  // ------------------------------------------------------------------------------------------------ the model
  function create({ S, LS, toast, onChange }) {
    let ov = {};
    try { const v = LS.get("stations_override", null); if (v && typeof v === "object") ov = v; } catch (_) { ov = {}; }
    let xml = null;                                                  // the last StationXML read: {name, entries, matches}

    const statusOf = (s) => {
      if (!(isNum(s.lat) && isNum(s.lon))) return null;              // no numbers: listed, never placed
      if (s.pos_status === "measured" || s.pos_status === "approx") return s.pos_status;
      return s.pending ? "approx" : "measured";                      // before v0.13: pending meant a placeholder
    };
    // the stations as the map draws them: the published fields, an override on top
    function list() {
      return (S.M.stations || []).map((s) => {
        const o = ov[s.id], m = o ? { ...s, ...o } : { ...s };
        const st = statusOf(m);
        return { ...m, pos_status: st, pos_err_m: isNum(m.pos_err_m) ? m.pos_err_m : null, pos_source: m.pos_source ?? m.source ?? null,
                 placed: st != null, approx: st === "approx", edited: !!o };
      });
    }
    const save = () => { LS.set("stations_override", ov); onChange && onChange(); };
    function edit(id, fields) {
      const cur = list().find((s) => s.id === id); if (!cur) return;
      const base = ov[id] || { lat: cur.lat, lon: cur.lon, elev: cur.elev ?? null, pos_status: cur.pos_status || "approx", pos_err_m: cur.pos_err_m };
      ov[id] = { ...base, ...fields, pos_source: fields.pos_source || EDITED };
      if (!(isNum(ov[id].lat) && isNum(ov[id].lon))) ov[id].pos_status = ov[id].pos_status || "approx";
      save();
    }
    function reset() { ov = {}; xml = null; save(); }
    // stations_override.json: the edited stations only, in the published fields (CONTRACT 0.13)
    function exportJSON() {
      const ids = Object.keys(ov), L = list().filter((s) => ids.includes(s.id));
      return JSON.stringify({ _what: "dark_svartsengi station positions edited in the page (CONTRACT 0.13 §4.2): page-local overrides; the published data (viz/data) was not changed. Pass this file to the pipeline (W1) to fold in.",
        contract: "0.13", made: new Date().toISOString(), data_built: S.M.built || null,
        stations: L.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, elev: isNum(s.elev) ? s.elev : null, pos_status: s.pos_status, pos_source: ov[s.id].pos_source || EDITED, pos_err_m: s.pos_err_m })) }, null, 1);
    }
    // a stations_override.json read back (the same file this page saves)
    function importJSON(j) {
      const rows = (j && (j.stations || j)) || [];
      if (!Array.isArray(rows)) throw new Error("no stations list in it");
      let n = 0;
      for (const r of rows) if (r && (S.M.stations || []).some((s) => s.id === r.id) && isNum(+r.lat) && isNum(+r.lon)) {
        ov[r.id] = { lat: +r.lat, lon: +r.lon, elev: isNum(+r.elev) && r.elev != null ? +r.elev : null, pos_status: r.pos_status === "measured" ? "measured" : "approx",
                     pos_err_m: isNum(+r.pos_err_m) && r.pos_err_m != null ? +r.pos_err_m : null, pos_source: r.pos_source || EDITED }; n++;
      }
      save(); return n;
    }
    function readXML(text, name) {
      const entries = parseStationXML(text);
      const matches = (S.M.stations || []).map((s) => ({ id: s.id, m: matchXML(s, entries) }));
      xml = { name: name || "pasted", entries, matches, pick: Object.fromEntries(matches.filter((x) => x.m && x.m.ok).map((x) => [x.id, true])) };
      return xml;
    }
    function applyXML() {
      if (!xml) return 0; let n = 0;
      for (const { id, m } of xml.matches) if (m && xml.pick[id]) {
        ov[id] = { lat: m.lat, lon: m.lon, elev: isNum(m.elev) ? m.elev : null, pos_status: "measured", pos_err_m: m.e.err_m,
                   pos_source: `${EDITED} · StationXML ${xml.name}: ${m.e.net}.${m.e.sta}, ${m.from}` }; n++;
      }
      save(); return n;
    }

    // ---------------------------------------------------------------------------------------------- the dock section
    // a small table per station (id, lat, lon, ± m, status; its source under it), the StationXML reader, save / reset
    const f6 = (v) => (isNum(v) ? (+v).toFixed(5) : "");
    function render(el) {
      const L = list(), nEd = Object.keys(ov).length;
      el.innerHTML = `<div class="sl">stations</div>
        <div class="hint" style="margin:0 0 8px" title="the positions the map draws and the sound is heard from; an edit applies at once and stays in this page (this browser)"><b>approx</b> = a placeholder, hollow on the map · edits apply at once</div>
        <table class="sttab"><thead><tr><th>id</th><th>lat °N</th><th>lon °E</th><th>± m</th><th>status</th></tr></thead><tbody>
        ${L.map((s) => `<tr class="${s.edited ? "ed" : ""}" data-id="${esc(s.id)}">
            <td class="sid" title="${esc(s.label || s.id)}">${esc(s.id.split(".").length >= 2 ? s.id.split(".")[1] : s.id)}<small>${esc(s.kind || "")}</small></td>
            <td><input type="text" inputmode="decimal" data-f="lat" value="${f6(s.lat)}" placeholder="—" spellcheck="false"></td>
            <td><input type="text" inputmode="decimal" data-f="lon" value="${f6(s.lon)}" placeholder="—" spellcheck="false"></td>
            <td><input type="text" inputmode="decimal" data-f="pos_err_m" value="${isNum(s.pos_err_m) ? s.pos_err_m : ""}" placeholder="?" spellcheck="false"></td>
            <td><select data-f="pos_status"><option value="approx"${s.pos_status !== "measured" ? " selected" : ""}>approx</option><option value="measured"${s.pos_status === "measured" ? " selected" : ""}>measured</option></select></td></tr>
          <tr class="ssrc${s.edited ? " ed" : ""}"><td></td><td colspan="4" title="${esc(s.pos_source || "no position yet: pending StationXML")}">${s.placed ? "" : "not placed · "}${esc(shortSource(s) || "pending StationXML")}${s.edited ? " <span class=\"sed\">●</span>" : ""}</td></tr>`).join("")}
        </tbody></table>
        <div class="sl">StationXML</div>
        <textarea id="stxml" rows="3" spellcheck="false" placeholder="paste StationXML here (FDSN, any version), or choose a file"></textarea>
        <div class="sline" style="margin-top:6px"><button class="btn" id="stxread">read</button><label class="btn" for="stxfile">choose a file…</label>
          <input type="file" id="stxfile" accept=".xml,.json,application/xml,text/xml,application/json" hidden></div>
        <div id="stxres">${xmlResult()}</div>
        <div class="sl">save</div>
        <div class="sline wrap"><button class="btn" id="stsave"${nEd ? "" : " disabled"}>download stations_override.json</button><button class="btn" id="stcopy"${nEd ? "" : " disabled"}>copy</button>
          <button class="btn" id="streset"${nEd ? "" : " disabled"} title="forget every edit: back to the published positions">reset</button></div>
        <div class="hint" title="the published data never changes here: send the file to the pipeline to fold the positions in; a saved file can be read back with &quot;choose a file…&quot;">${nEd ? `${nEd} edited here · the published data is unchanged` : "nothing edited"}</div>`;
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        const id = tr.dataset.id;
        tr.querySelectorAll("input,select").forEach((inp) => (inp.onchange = () => {
          const f = inp.dataset.f, raw = inp.value.trim().replace(",", ".");
          if (f === "pos_status") { edit(id, { pos_status: inp.value }); render(el); return; }
          const v = raw === "" ? null : +raw;
          if (raw !== "" && !isNum(v)) { toast(`${f === "pos_err_m" ? "the uncertainty" : f} is a number`); inp.value = ""; return; }
          if (f === "lat" && v != null && (v < -90 || v > 90)) { toast("latitude is −90 … 90"); return; }
          if (f === "lon" && v != null && (v < -180 || v > 180)) { toast("longitude is −180 … 180 (west is negative)"); return; }
          edit(id, { [f]: v }); render(el);
        }));
      });
      const readText = (text, name) => {
        const t = text.trim(); if (!t) { toast("paste StationXML first, or choose a file"); return; }
        try {
          if (/^[[{]/.test(t)) { const n = importJSON(JSON.parse(t)); toast(`${n} station position${n === 1 ? "" : "s"} read from ${name}`); xml = null; }
          else readXML(t, name);
        } catch (e) { toast(`could not read it: ${e.message}`); xml = null; }
        render(el);
      };
      el.querySelector("#stxread").onclick = () => readText(el.querySelector("#stxml").value, "pasted");
      el.querySelector("#stxfile").onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) f.text().then((t) => readText(t, f.name)); };
      const ap = el.querySelector("#stxapply");
      if (ap) ap.onclick = () => { const n = applyXML(); toast(`${n} position${n === 1 ? "" : "s"} from StationXML applied`); xml = null; render(el); };
      el.querySelectorAll("input[data-pick]").forEach((c) => (c.onchange = () => { xml.pick[c.dataset.pick] = c.checked; }));
      el.querySelector("#stsave").onclick = () => {
        const a = document.createElement("a"), url = URL.createObjectURL(new Blob([exportJSON()], { type: "application/json" }));
        a.href = url; a.download = "stations_override.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      el.querySelector("#stcopy").onclick = async () => {
        const txt = exportJSON();
        try { await navigator.clipboard.writeText(txt); toast("stations_override.json copied"); }
        catch (_) { el.querySelector("#stxml").value = txt; el.querySelector("#stxml").select(); toast("the clipboard is blocked here: the file is in the box above, selected"); }
      };
      el.querySelector("#streset").onclick = () => { reset(); render(el); toast("back to the published positions"); };
    }
    function xmlResult() {
      if (!xml) return "";
      const rows = xml.matches.map(({ id, m }) => m
        ? `<label class="sxr${m.ok ? "" : " warn"}"><input type="checkbox" data-pick="${esc(id)}"${xml.pick[id] ? " checked" : ""}> <b>${esc(id)}</b> ← ${esc(m.e.net)}.${esc(m.e.sta)}
            ${f6(m.lat)}, ${f6(m.lon)}${isNum(m.elev) ? ` · ${Math.round(m.elev)} m` : ""} <span class="dim">(${esc(m.from)})</span>${m.warn.length ? `<br><span class="sw">⚠ ${esc(m.warn.join("; "))}</span>` : ""}</label>`
        : `<div class="sxr none"><b>${esc(id)}</b> <span class="dim">not in this file</span></div>`).join("");
      const n = xml.entries.length, any = xml.matches.some((x) => x.m);
      return `<div class="hint" style="margin:6px 0">${esc(xml.name)}: ${n} station epoch${n === 1 ? "" : "s"} (${esc([...new Set(xml.entries.map((e) => `${e.net}.${e.sta}`))].slice(0, 8).join(", "))}${n > 8 ? ", …" : ""})</div>${rows}
        ${any ? `<button class="btn" id="stxapply" style="margin-top:6px">apply the ticked as measured</button>` : ""}`;
    }

    return { list, edit, reset, exportJSON, importJSON, readXML, applyXML, render, edited: () => Object.keys(ov).length };
  }

  return { create, parseStationXML, matchXML, idParts, shortSource };
})();
