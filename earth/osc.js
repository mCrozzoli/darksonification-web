// dark_svartsengi — web build · OSC 1.0, the few pieces the in-tab relay needs (hand-written).
// Encoder: typed helpers f()/i()/s() reproduce viz/bridge.py's float()/int()/str() casts; untyped JS values fall back
// to string -> s, integer -> i, other number -> f. A float NaN is the contract's null (CONTRACT §5.1).
// Parser: messages only (a "#bundle" is not parsed: nothing the relay intercepts is ever sent as one).
// setnMessage(): /b_setn for one slice of a Float32Array, written straight into the bytes (a Ground ring block is
// 16,384 floats; building 16,384 typed-arg objects per block would be the slow way).
const enc = new TextEncoder();
const dec = new TextDecoder();

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

// "/b_setn" ",iii" + n×"f" | bufnum, offset, n, floats — the n floats are arr[start .. start+n)
export function setnMessage(bufnum, offset, arr, start, n) {
  const tagLen = Math.ceil((1 + 3 + n + 1) / 4) * 4;   // "," + "iii" + n "f" + NUL, padded
  const out = new Uint8Array(8 + tagLen + 12 + 4 * n);
  out.set(enc.encode("/b_setn"), 0);                   // the address: 7 bytes + NUL = 8, no padding needed
  let o = 8;
  out[o] = 0x2c; out[o + 1] = 0x69; out[o + 2] = 0x69; out[o + 3] = 0x69;   // ",iii"
  out.fill(0x66, o + 4, o + 4 + n);                    // "f" × n, then NUL padding (already 0)
  o += tagLen;
  const dv = new DataView(out.buffer);
  dv.setInt32(o, bufnum, false); dv.setInt32(o + 4, offset, false); dv.setInt32(o + 8, n, false);
  o += 12;
  for (let k = 0; k < n; k++, o += 4) dv.setFloat32(o, arr[start + k], false);
  return out;
}

const bytesOf = (p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p));
function readStr(b, o) {
  let e = o; while (e < b.length && b[e] !== 0) e++;
  return [dec.decode(b.subarray(o, e)), Math.ceil((e + 1) / 4) * 4];
}
// the address only (cheap: every packet on the sclang → scsynth wire passes through here)
export function oscAddress(p) {
  const b = bytesOf(p);
  if (!b.length || b[0] !== 0x2f) return b.length && b[0] === 0x23 ? "#bundle" : "";
  let e = 0; while (e < b.length && b[e] !== 0) e++;
  return dec.decode(b.subarray(0, e));
}
// {address, args} with i/f/s/b/T/F/N decoded; null for a bundle or a malformed packet
export function parseOsc(p) {
  const b = bytesOf(p);
  if (!b.length || b[0] !== 0x2f) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let [address, o] = readStr(b, 0);
  if (o >= b.length || b[o] !== 0x2c) return { address, args: [] };
  let tags; [tags, o] = readStr(b, o);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === "i") { args.push(dv.getInt32(o, false)); o += 4; }
    else if (t === "f") { args.push(dv.getFloat32(o, false)); o += 4; }
    else if (t === "s") { let v; [v, o] = readStr(b, o); args.push(v); }
    else if (t === "b") { const n = dv.getInt32(o, false); args.push(b.slice(o + 4, o + 4 + n)); o += 4 + Math.ceil(n / 4) * 4; }
    else if (t === "T") args.push(true);
    else if (t === "F") args.push(false);
    else if (t === "N") args.push(null);
    else if (t === "d") { args.push(dv.getFloat64(o, false)); o += 8; }
    else if (t === "h") { args.push(Number(dv.getBigInt64(o, false))); o += 8; }
    else return { address, args, partial: true };
  }
  return { address, args };
}
