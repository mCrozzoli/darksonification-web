// dark_svartsengi — web build · the relay's two pure functions (hand-written). No DOM, no engine: Node imports this
// file for the drift gate (build/check_relay.mjs), and engine.js imports it in the tab.
//
// They are viz/bridge.py's json_to_osc() and osc_to_json(), line for line, over the same table (viz/svk_messages.json,
// CONTRACT v0.8 §5 as data; the build copies it to view/svk_messages.json). build/build_data.py runs the bridge's own
// functions over every fixture message and writes build/relay_vectors.json; check_relay.mjs encodes the same messages
// here and compares the OSC bytes. A difference stops the build.
import { f, i, s } from "./osc.js";

// Python's round(): half to even (bridge.py casts an "i" field with int(round(float(v))))
function pyRound(x) {
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
}

// a page message -> [address, typed args] in the contract's order; null when it is not a contract message.
// Throws when a non-nullable field is missing (the bridge raises ValueError; its relay drops that one message).
export function toOsc(schema, msg) {
  const spec = schema.page_to_engine[msg && msg.type];
  if (!spec) return null;
  const nullable = new Set(spec.nullable || []);
  const args = [];
  const cast = (name, ty, v) => {
    if (ty === "i") {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`${msg.type}: ${name} is not a number`);
      args.push(i(pyRound(x)));
    } else if (ty === "f") args.push(f(Number(v)));
    else args.push(s(v));
  };
  const fixed = (arglist) => {
    for (const [name, ty] of arglist) {
      const v = msg[name];
      if (v === null || v === undefined) {
        // OSC has no null: a nullable float goes out as NaN, which the engine reads as nil (svk_messages.json "_null")
        if (ty === "f" && nullable.has(name)) { args.push(f(NaN)); continue; }
        throw new Error(`${msg.type}: ${name} missing`);
      }
      cast(name, ty, v);
    }
  };
  fixed(spec.args);
  // v0.11 repeat groups (/svk_identity): each item's args in order, group after group
  for (const grp of spec.repeat || []) {
    const items = msg[grp.field] || [], count = Math.trunc(Number(msg[grp.count] ?? 0));
    if (items.length !== count) throw new Error(`${msg.type}: ${grp.field} has ${items.length} items, ${grp.count} = ${count}`);
    for (const it of items) {
      for (const [name, ty] of grp.args) {
        const v = it !== null && typeof it === "object" && !Array.isArray(it) ? it[name] : it;
        if (v === null || v === undefined) { args.push(f(NaN)); continue; }   // a missing value in a group is NaN (never a sound)
        cast(name, ty, v);
      }
    }
  }
  fixed(spec.tail || []);                                // v0.11.6: args after the groups (/svk_identity room_gain)
  return [spec.addr, args];
}

// an engine message -> the page's JSON. A float NaN (or ±inf) becomes null: JSON has no NaN.
// Unknown addresses pass through as {type:"osc"} for the debug panel (the tab never relays one: see engine.js).
export function fromOsc(schema, addr, args) {
  const spec = schema.engine_to_page[addr];
  if (!spec) return { type: "osc", addr, args: args.map((a) => (typeof a === "number" || typeof a === "string" ? a : String(a))) };
  const out = { type: spec.type };
  spec.args.forEach(([name, ty], k) => {
    if (k >= args.length) return;                       // zip(): a short message fills only what it carries
    const v = args[k];
    if (ty === "f") { const x = Number(v); out[name] = Number.isFinite(x) ? x : null; }
    else if (ty === "i") out[name] = Math.trunc(Number(v));
    else out[name] = String(v);
  });
  return out;
}

export const engineAddresses = (schema) => Object.keys(schema.engine_to_page);
