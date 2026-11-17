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
