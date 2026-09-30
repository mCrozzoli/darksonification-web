// Minimal OSC 1.0 message encoder for the /dark_* contract.
// Typed helpers f()/i()/s() reproduce bridge.py's float()/int()/str() casts exactly;
// untyped JS values fall back to: string -> s, integer -> i, other number -> f.
const enc = new TextEncoder();

export const f = (v) => ({ t: "f", v: Number(v) });
export const i = (v) => ({ t: "i", v: Math.trunc(Number(v)) });
export const s = (v) => ({ t: "s", v: String(v) });

function oscString(str) {
  const bytes = enc.encode(str);
  const out = new Uint8Array(Math.ceil((bytes.length + 1) / 4) * 4); // NUL-terminated, 4-byte padded
  out.set(bytes);
  return out;
}

function typed(a) {
  if (a && typeof a === "object" && "t" in a) return a;
  if (typeof a === "string") return s(a);
  return Number.isInteger(a) ? i(a) : f(a);
}

// Decode one OSC message (not a bundle) into {address, args:[{t, v}]}; null for anything else.
// Used to read sclang's own messages on their way to scsynth (/rw_clip_want) and the server's replies (/done).
const dec = new TextDecoder();
export function oscParse(pkt) {
  const b = pkt instanceof Uint8Array ? pkt : new Uint8Array(pkt.buffer || pkt);
  if (b.length < 8 || b[0] !== 47) return null;                       // "/"
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const str = () => { let e = o; while (e < b.length && b[e] !== 0) e++; const t = dec.decode(b.subarray(o, e)); o = (e + 4) & ~3; return t; };
  const address = str(), tags = str(), args = [];
  for (const t of tags.slice(1)) {
    if (t === "i") { args.push({ t, v: dv.getInt32(o) }); o += 4; }
    else if (t === "f") { args.push({ t, v: dv.getFloat32(o) }); o += 4; }
    else if (t === "s") args.push({ t, v: str() });
    else if (t === "b") { const n = dv.getInt32(o); o += 4 + ((n + 3) & ~3); args.push({ t, v: null }); }
    else break;
  }
  return { address, args };
}

export function oscMessage(address, args = []) {
  let tags = ",";
  const data = [];
  for (const raw of args) {
    const a = typed(raw);
    tags += a.t;
    if (a.t === "s") { data.push(oscString(a.v)); continue; }
    const b = new Uint8Array(4);
    const dv = new DataView(b.buffer);
    if (a.t === "i") dv.setInt32(0, a.v, false); else dv.setFloat32(0, a.v, false);
    data.push(b);
  }
  const chunks = [oscString(address), oscString(tags), ...data];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
