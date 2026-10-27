// Copied from projects/designs/dark_music_corpus/web_implementation/core/tokenizer.js on 2026-10-27 for Uncanny Listening (credit: the
// Dark Music Corpus web engine). Changes here: none.
// RoBERTa byte-level BPE (the CLAP text side's RobertaTokenizer): GPT-2 pre-tokenisation regex, bytes → unicode map,
// merges by rank, ids from vocab.json, wrapped as <s> … </s>. No normaliser, no prefix space (tokenizer_config).
const PAT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
const B2U = (() => {
  const bs = []; for (let b = 33; b <= 126; b++) bs.push(b); for (let b = 161; b <= 172; b++) bs.push(b); for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice(); let n = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = new Array(256); bs.forEach((b, i) => { m[b] = String.fromCharCode(cs[i]); }); return m;
})();
export class Tokenizer {
  constructor(vocab, mergesText) {
    this.vocab = vocab; this.ranks = new Map(); this.cache = new Map();
    mergesText.split("\n").filter((l) => l && !l.startsWith("#version")).forEach((l, i) => this.ranks.set(l, i));
  }
  bpe(token) {
    if (this.cache.has(token)) return this.cache.get(token);
    let word = Array.from(token);
    while (word.length > 1) {
      let best = null, br = Infinity;
      for (let i = 0; i < word.length - 1; i++) { const r = this.ranks.get(word[i] + " " + word[i + 1]); if (r !== undefined && r < br) { br = r; best = i; } }
      if (best === null) break;
      const a = word[best], b = word[best + 1], out = [];
      for (let i = 0; i < word.length; ) { if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { out.push(a + b); i += 2; } else { out.push(word[i]); i++; } }
      word = out;
    }
    this.cache.set(token, word); return word;
  }
  encode(text) {
    const ids = [0], enc = new TextEncoder();
    for (const m of text.matchAll(PAT)) {
      const u = Array.from(enc.encode(m[0]), (b) => B2U[b]).join("");
      for (const piece of this.bpe(u)) ids.push(this.vocab[piece] ?? this.vocab["<unk>"]);
    }
    ids.push(2); return ids;
  }
}
