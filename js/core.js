/* Percival core: parsing, normalisation, distance law, Poisson likelihood, layout edits, hints, exports.
   DOM-free; runs in browsers (window.Percival) and Node (require). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Percival = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const GAP = 100, FIELD = /[\t ,]+/, HASH = 35, COARSE = 8 / Math.LN10, FINE = 48;

  /* ───────────── small utilities ───────────── */

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const gauss = rand => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());

  function poisson(rand, lam) {
    if (lam <= 0) return 0;
    if (lam > 40) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss(rand)));
    const limit = Math.exp(-lam);
    let k = 0, p = rand();
    while (p > limit) { k++; p *= rand(); }
    return k;
  }

  const LANCZOS = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  /** ln(x!) for real x >= 0. */
  const lnFact = x => x === 0 || x === 1 ? 0 : lnGamma(x + 1);
  function lnGamma(x) {
    let y = x, t = x + 5.5, s = 1.000000000190015;
    t -= (x + 0.5) * Math.log(t);
    for (let k = 0; k < 6; k++) s += LANCZOS[k] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }

  function fmtBp(bp) {
    const a = Math.abs(bp);
    if (a >= 1e9) return (bp / 1e9).toFixed(2) + ' Gb';
    if (a >= 1e6) return (bp / 1e6).toFixed(2) + ' Mb';
    if (a >= 1e3) return (bp / 1e3).toFixed(a >= 1e5 ? 0 : 1) + ' kb';
    return Math.round(bp) + ' bp';
  }

  class Bytes {
    constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
    push(u8) {
      const need = this.len + u8.length;
      if (need > this.buf.length) {
        const grown = new Uint8Array(Math.max(need, this.buf.length * 2));
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
      }
      this.buf.set(u8, this.len);
      this.len = need;
    }
    done() { return this.buf.slice(0, this.len); }
  }

  /* ───────────── reading: plain, gzip and BGZF, streamed ───────────── */

  const inflateRaw = async u8 => new Uint8Array(await new Response(
    new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());

  async function forEachChunk(blob, onBytes) {
    const head = new Uint8Array(await blob.slice(0, 18).arrayBuffer());
    const gz = head[0] === 0x1f && head[1] === 0x8b;
    if (gz && (head[3] & 4) && head[12] === 66 && head[13] === 67) {
      // BGZF (bgzip): independent deflate blocks, inflated in parallel per 16 MiB window.
      for (let off = 0; off < blob.size;) {
        const buf = new Uint8Array(await blob.slice(off, off + (1 << 24)).arrayBuffer()), jobs = [];
        let p = 0;
        while (p + 18 <= buf.length) {
          const size = (buf[p + 16] | buf[p + 17] << 8) + 1;
          if (p + size > buf.length) break;
          jobs.push(inflateRaw(buf.subarray(p + 18, p + size - 8)));
          p += size;
        }
        if (!p) throw new Error('Truncated BGZF block');
        for (const part of await Promise.all(jobs)) onBytes(part);
        off += p;
      }
      return;
    }
    const reader = (gz ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes(value);
    }
  }

  class FastaSink {
    constructor() { this.seqs = new Map(); this.cur = null; this.name = null; this.hdr = null; this.bol = true; this.dec = new TextDecoder(); }
    flush() { if (this.cur) this.seqs.set(this.name, this.cur.done()); }
    push(u8) {
      const n = u8.length;
      let p = 0;
      while (p < n) {
        if (this.hdr !== null) {
          const e = u8.indexOf(10, p);
          this.hdr += this.dec.decode(u8.subarray(p, e < 0 ? n : e), { stream: true });
          if (e < 0) return;
          this.flush();
          this.name = this.hdr.trim().split(/\s+/)[0];
          this.cur = new Bytes();
          this.hdr = null; this.bol = true; p = e + 1;
        } else if (this.bol && u8[p] === 62) {
          this.hdr = ''; p++;
        } else {
          const e = u8.indexOf(10, p), q = e < 0 ? n : e;
          const end = q > p && u8[q - 1] === 13 ? q - 1 : q;
          if (this.cur && end > p) this.cur.push(u8.subarray(p, end));
          this.bol = e >= 0; p = q + 1;
        }
      }
    }
    done() { this.flush(); return { type: 'fasta', seqs: this.seqs }; }
  }

  const isNum = s => s !== '' && Number.isFinite(+s), isInt = s => /^\d+$/.test(s);

  /** Decide what a text file is from its name and first lines. */
  function sniff(name, lines) {
    const ext = name.toLowerCase().replace(/\.(gz|bgz|txt)$/, '').split('.').pop();
    let data = lines.filter(l => l.charCodeAt(0) !== HASH).map(l => l.trim().split(FIELD));
    if (data.length > 1 && !data[0].every(isNum) && data.slice(1).every(r => r.every(isNum)) && !/start_pos/.test(lines[0])) data = data.slice(1);
    const f = data[0] || [];
    if (lines[0].trimStart()[0] === '{') return 'session';
    if (lines[0].startsWith('##agp-version') || ext === 'agp' || (f.length >= 9 && /^[WNUADFGOP]$/.test(f[4]) && isInt(f[1]) && isInt(f[2]))) return 'agp';
    if (ext === 'pairs' || lines.some(l => l.startsWith('## pairs')) || (f.length >= 7 && isInt(f[2]) && isInt(f[4]) && /^[+-]$/.test(f[5]))) return 'pairs';
    if (lines.some(l => /start_pos/.test(l)) || /^id\s+chrom/.test(lines[0])) return 'frags';
    const allNum = data.every(r => r.every(isNum));
    if (f.length >= 7 && isInt(f[1]) && isInt(f[2]) && isInt(f[4]) && isInt(f[5]) && isNum(f[6]) &&
        !(allNum && (f.length > 7 || data.some(r => +r[2] <= +r[1] || +r[5] <= +r[4])))) return 'bg2';
    if (f.length === 3 || (f.length >= 3 && !isNum(f[0]) && isInt(f[1]) && isInt(f[2]))) {
      const tiled = data.some((r, k) => k && r[0] === data[k - 1][0]) && data.every((r, k) => +r[2] > +r[1] && (!k || r[0] !== data[k - 1][0] || r[1] === data[k - 1][2]));
      return allNum && !tiled && ext !== 'bed' ? 'coo' : 'bins';
    }
    if ((f.length === 2 || f.length === 5) && !allNum && f.slice(1).every(isInt)) return 'sizes';
    if (f.length === 2 && ext === 'sizes') return 'sizes';
    if (allNum && f.length >= 4) return 'dense';
    throw new Error(`Could not recognise the format of ${name}. See the format list in the Load dialog.`);
  }

  function coordSink(pairs, binSize) {
    const chroms = new Map(), sizes = new Map(), key2bin = new Map(), acc = new Map();
    const bChrom = [], bStart = [], bEnd = [], I = [], J = [], V = [];
    const cid = name => { let c = chroms.get(name); if (c === undefined) chroms.set(name, c = chroms.size); return c; };
    const bin = (c, start, end) => {
      const key = c * 4294967296 + start;
      let b = key2bin.get(key);
      if (b === undefined) { key2bin.set(key, b = bChrom.length); bChrom.push(c); bStart.push(start); bEnd.push(end); }
      return b;
    };
    const tile = (name, pos) => { const s = Math.floor((pos - 1) / binSize) * binSize; return bin(cid(name), s, s + binSize); };
    return {
      line(l) {
        if (l.charCodeAt(0) === HASH) {
          if (l.startsWith('#chromsize:')) { const f = l.split(FIELD); sizes.set(f[1], +f[2]); cid(f[1]); }
          return;
        }
        const f = l.trim().split(FIELD);
        if (!isInt(f[pairs ? 2 : 1] || '')) return;
        if (pairs) {
          const a = tile(f[1], +f[2]), b = tile(f[3], +f[4]), key = a < b ? a * 67108864 + b : b * 67108864 + a;
          acc.set(key, (acc.get(key) || 0) + 1);
        } else {
          I.push(bin(cid(f[0]), +f[1], +f[2])); J.push(bin(cid(f[3]), +f[4], +f[5])); V.push(f.length > 6 ? +f[6] : 1);
        }
      },
      done() {
        for (const [key, v] of acc) { I.push(Math.floor(key / 67108864)); J.push(key % 67108864); V.push(v); }
        return { type: 'contacts', coord: { chroms: [...chroms.keys()], sizes, bChrom, bStart, bEnd }, I, J, V };
      }
    };
  }

  const SINKS = {
    dense() {
      const rows = [];
      return {
        line(l) { const f = l.trim().split(FIELD); if (l.charCodeAt(0) !== HASH && isNum(f[0])) rows.push(Float32Array.from(f, Number)); },
        done() {
          const n = rows.length;
          if (rows.some(r => r.length !== n)) throw new Error(`The dense matrix is not square: ${n} rows but ${rows[0].length} columns.`);
          const data = new Float32Array(n * n);
          rows.forEach((r, i) => data.set(r, i * n));
          return { type: 'contacts', n, data };
        }
      };
    },
    coo() {
      const I = [], J = [], V = [];
      return {
        line(l) { const f = l.trim().split(FIELD); if (l.charCodeAt(0) !== HASH && isNum(f[0])) { I.push(+f[0]); J.push(+f[1]); V.push(+f[2]); } },
        done() {
          let lo = Infinity, hi = 0;
          for (let k = 1; k < I.length; k++) { lo = Math.min(lo, I[k], J[k]); hi = Math.max(hi, I[k], J[k]); }
          // GRAAL / hicstuff sparse matrices open with "N N nnz".
          const header = I.length > 1 && I[0] === J[0] && I[0] >= hi && (V[0] === I.length - 1 || I[0] > hi);
          if (header) return { type: 'contacts', n: I[0], lo, hi, I: I.slice(1), J: J.slice(1), V: V.slice(1) };
          return { type: 'contacts', n: null, lo: Math.min(lo, I[0], J[0]), hi: Math.max(hi, I[0], J[0]), I, J, V };
        }
      };
    },
    bg2: () => coordSink(false),
    pairs: opts => coordSink(true, opts.binSize),
    bins(_, kind) {
      const chrom = [], start = [], end = [], o = kind === 'frags' ? 1 : 0;
      return {
        line(l) {
          const f = l.split(FIELD), s = +f[o + 1], e = +f[o + 2];
          if (l.charCodeAt(0) !== HASH && isNum(f[o + 1] || '') && isNum(f[o + 2] || '')) { chrom.push(f[o]); start.push(s); end.push(e); }
        },
        done: () => ({ type: 'bins', chrom, start, end })
      };
    },
    sizes() {
      const sizes = new Map();
      return { line(l) { const f = l.split(FIELD); if (l.charCodeAt(0) !== HASH && isNum(f[1] || '')) sizes.set(f[0], +f[1]); }, done: () => ({ type: 'sizes', sizes }) };
    },
    agp() {
      const rows = [];
      return {
        line(l) { const f = l.split('\t'); if (l.charCodeAt(0) !== HASH && f[4] === 'W') rows.push({ obj: f[0], comp: f[5], beg: +f[6] - 1, end: +f[7], rev: f[8] === '-' }); },
        done: () => ({ type: 'agp', rows })
      };
    },
    session() {
      const text = [];
      return {
        line(l) { text.push(l); },
        done() {
          const s = JSON.parse(text.join('\n'));
          if (s.format !== 'percival-session') throw new Error('This JSON file is not a Percival session.');
          return { type: 'session', session: s };
        }
      };
    }
  };
  SINKS.frags = opts => SINKS.bins(opts, 'frags');

  /** Read one input (File/Blob) and return a typed part: fasta | contacts | bins | sizes | agp | session. */
  async function ingest(name, blob, opts = {}) {
    const dec = new TextDecoder(), pending = [];
    let fasta = null, sink = null, tail = '', started = false, kind = 'fasta';
    const open = () => { kind = sniff(name, pending); sink = SINKS[kind]({ binSize: 10000, ...opts }); pending.forEach(sink.line); };
    const line = l => { if (sink) sink.line(l); else if (pending.push(l) === 64) open(); };
    await forEachChunk(blob, bytes => {
      if (!started) {
        let k = 0;
        while (k < bytes.length && bytes[k] <= 32) k++;
        if (k === bytes.length) return;
        started = true;
        if (bytes[k] === 62) fasta = new FastaSink();
      }
      if (fasta) return fasta.push(bytes);
      const text = tail + dec.decode(bytes, { stream: true });
      let p = 0, e;
      while ((e = text.indexOf('\n', p)) >= 0) {
        const l = text.charCodeAt(e - 1) === 13 ? text.slice(p, e - 1) : text.slice(p, e);
        if (l) line(l);
        p = e + 1;
      }
      tail = text.slice(p);
    });
    if (fasta) return { ...fasta.done(), kind, name };
    if (tail.trim()) line(tail.replace(/\r$/, ''));
    if (!sink) {
      if (!pending.length) throw new Error(`${name} is empty.`);
      open();
    }
    return { ...sink.done(), kind, name };
  }

  /* ───────────── dataset assembly ───────────── */

  /** Combine parts {contacts, bins?, sizes?, fasta?} into a dense, symmetric, balanced dataset. */
  function build(parts, { binSize = 10000, maxBins = 2500 } = {}) {
    let c = parts.contacts;
    const table = parts.bins, notes = [];
    if (!c) throw new Error('No contact map yet. Add a dense matrix, sparse triplets, a bg2 file or a .pairs file.');
    const lens = new Map(parts.sizes ? parts.sizes.sizes : []);
    if (parts.fasta) for (const [k, s] of parts.fasta.seqs) lens.set(k, s.length);
    let chrom, start, end, map;

    if (c.coord) {
      const q = c.coord, nb = q.bChrom.length;
      for (const [k, v] of q.sizes) if (!lens.has(k)) lens.set(k, v);
      map = new Int32Array(nb);
      if (table) {
        const byChrom = new Map();
        table.chrom.forEach((name, k) => { if (!byChrom.has(name)) byChrom.set(name, []); byChrom.get(name).push(k); });
        for (const list of byChrom.values()) list.sort((a, b) => table.start[a] - table.start[b]);
        for (let b = 0; b < nb; b++) {
          const name = q.chroms[q.bChrom[b]], list = byChrom.get(name) || [];
          let lo = 0, hi = list.length - 1, hit = -1;
          while (lo <= hi) { const m = (lo + hi) >> 1; if (table.start[list[m]] <= q.bStart[b]) { hit = list[m]; lo = m + 1; } else hi = m - 1; }
          if (hit < 0) throw new Error(`The contact file refers to ${name}:${q.bStart[b]}, which is not in the bin table.`);
          map[b] = hit;
        }
        ({ chrom, start, end } = table);
      } else {
        // order chromosomes as in the FASTA / sizes file when given, else by first appearance
        const order = [...lens.keys()], rank = q.chroms.map((x, k) => { const r = order.indexOf(x); return r < 0 ? order.length + k : r; });
        const ids = q.chroms.map((_, k) => k).sort((x, y) => rank[x] - rank[y]), widths = new Map();
        for (let b = 0; b < nb; b++) { const w = q.bEnd[b] - q.bStart[b]; widths.set(w, (widths.get(w) || 0) + 1); }
        const step = [...widths].sort((x, y) => y[1] - x[1])[0][0];
        chrom = []; start = []; end = [];
        if (q.bStart.every(s => s % step === 0)) {
          // regular tiling: fill every tile so that empty bins keep genomic distances right
          const reach = new Float64Array(q.chroms.length), offset = new Int32Array(q.chroms.length);
          for (let b = 0; b < nb; b++) reach[q.bChrom[b]] = Math.max(reach[q.bChrom[b]], q.bEnd[b]);
          for (const id of ids) {
            const name = q.chroms[id], len = lens.get(name) || reach[id];
            offset[id] = chrom.length;
            for (let s = 0; s < len; s += step) { chrom.push(name); start.push(s); end.push(Math.min(len, s + step)); }
          }
          for (let b = 0; b < nb; b++) map[b] = offset[q.bChrom[b]] + q.bStart[b] / step;
        } else {
          const idx = Array.from({ length: nb }, (_, k) => k).sort((a, b) => rank[q.bChrom[a]] - rank[q.bChrom[b]] || q.bStart[a] - q.bStart[b]);
          idx.forEach((b, k) => {
            const name = q.chroms[q.bChrom[b]];
            map[b] = k; chrom.push(name); start.push(q.bStart[b]); end.push(Math.min(q.bEnd[b], lens.get(name) || Infinity));
          });
        }
      }
    } else {
      const base = c.data ? 0 : (c.lo >= 1 && c.hi === (c.n || (table ? table.chrom.length : -1)) ? 1 : 0);
      const n0 = c.data ? c.n : c.n || (table && base ? table.chrom.length : c.hi + 1 - base);
      const tiles = [...lens].reduce((s, [, len]) => s + Math.ceil(len / binSize), 0);
      if (table && table.chrom.length !== n0) throw new Error(`The bin table lists ${table.chrom.length} bins but the contact map has ${n0}.`);
      if (table) ({ chrom, start, end } = table);
      else {
        chrom = []; start = []; end = [];
        if (tiles === n0) {
          for (const [name, len] of lens) for (let s = 0; s < len; s += binSize) { chrom.push(name); start.push(s); end.push(Math.min(len, s + binSize)); }
        } else {
          if (lens.size) notes.push(`The sequences imply ${tiles} bins of ${fmtBp(binSize)} but the map has ${n0}; treating the map as one unnamed contig. Add a bin table or set the bin size to restore names and sequence export.`);
          for (let k = 0; k < n0; k++) { chrom.push('contig_1'); start.push(k * binSize); end.push((k + 1) * binSize); }
        }
      }
      map = Int32Array.from({ length: n0 }, (_, k) => k);
      if (!c.data && base) { c = { ...c, I: c.I.map(v => v - 1), J: c.J.map(v => v - 1) }; }
    }

    // Coarsen by merging k neighbouring bins per contig when the map is too large to hold densely.
    const k = Math.ceil(chrom.length / maxBins);
    if (k > 1) {
      const to = new Int32Array(chrom.length), nc = [], ns = [], ne = [];
      let run = 0;
      for (let b = 0; b < chrom.length; b++) {
        if (!b || chrom[b] !== chrom[b - 1] || run === k) { nc.push(chrom[b]); ns.push(start[b]); ne.push(end[b]); run = 0; }
        ne[ne.length - 1] = end[b]; to[b] = nc.length - 1; run++;
      }
      notes.push(`Merged every ${k} neighbouring bins to keep the map at ${nc.length} bins (limit ${maxBins}). Edits snap to these merged bins.`);
      for (let b = 0; b < map.length; b++) map[b] = to[map[b]];
      chrom = nc; start = ns; end = ne;
    }

    const n = chrom.length, counts = new Float32Array(n * n);
    if (c.data) {
      for (let i = 0, p = 0; i < c.n; i++) for (let j = 0, row = map[i] * n; j < c.n; j++, p++) { const v = c.data[p]; if (v > 0) counts[row + map[j]] += v; }
    } else {
      for (let t = 0; t < c.I.length; t++) {
        const i = map[c.I[t]], j = map[c.J[t]], v = c.V[t];
        if (i === undefined || j === undefined) throw new Error(`Contact ${t + 1} points at bin ${Math.max(c.I[t], c.J[t])}, beyond the ${map.length} bins available.`);
        if (v > 0) counts[i * n + j] += v;
      }
    }
    // Files list either one triangle or both; average when both are present, otherwise mirror.
    let both = 0, any = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = counts[i * n + j], b = counts[j * n + i];
      if (a > 0 || b > 0) { any++; if (a > 0 && b > 0) both++; }
    }
    const scale = both > any / 2 ? 0.5 : 1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) counts[i * n + j] = counts[j * n + i] = (counts[i * n + j] + counts[j * n + i]) * scale;

    const contigs = [], binContig = new Int32Array(n);
    for (let b = 0; b < n; b++) {
      if (!b || chrom[b] !== chrom[b - 1]) contigs.push({ name: chrom[b], first: b, count: 0, len: 0 });
      const ctg = contigs[contigs.length - 1];
      ctg.count++; ctg.len = Math.max(lens.get(ctg.name) || 0, end[b]); binContig[b] = contigs.length - 1;
    }
    const seqs = parts.fasta ? parts.fasta.seqs : null;
    if (seqs) {
      const missing = contigs.filter(x => !seqs.has(x.name)).length;
      if (missing) notes.push(`${missing} of ${contigs.length} contigs have no sequence in the FASTA; they export as N.`);
    }
    return finalize({ n, contigs, binContig, binStart: Float64Array.from(start), binEnd: Float64Array.from(end), counts, seqs, notes });
  }

  /** Iterative correction (ICE, Imakaev et al. 2012) with damped updates; returns per-bin bias with mean 1. */
  function balance(counts, n) {
    const bias = new Float64Array(n).fill(1), inv = new Float64Array(n), sum = new Float64Array(n);
    for (let i = 0, row = 0; i < n; i++, row += n) { let acc = -counts[row + i]; for (let j = 0; j < n; j++) acc += counts[row + j]; sum[i] = acc; }
    const cov = [...sum].filter(v => v > 0).sort((x, y) => x - y), floor = 0.1 * (cov[cov.length >> 1] || 0);
    for (let i = 0; i < n; i++) if (!(sum[i] > floor)) bias[i] = 0;
    for (let it = 0; it < 200; it++) {
      for (let i = 0; i < n; i++) inv[i] = bias[i] > 0 ? 1 / bias[i] : 0;
      let total = 0, live = 0, dev = 0;
      for (let i = 0, row = 0; i < n; i++, row += n) {
        let acc = -counts[row + i] * inv[i];
        for (let j = 0; j < n; j++) acc += counts[row + j] * inv[j];
        sum[i] = acc * inv[i];
        if (sum[i] > 0) { total += sum[i]; live++; }
      }
      if (!live) break;
      for (let i = 0; i < n; i++) {
        if (sum[i] > 0) { const r = Math.sqrt(sum[i] * live / total); bias[i] *= r; dev = Math.max(dev, Math.abs(r - 1)); }
        else bias[i] = 0;
      }
      if (dev < 5e-4) break;
    }
    let total = 0, live = 0;
    for (let i = 0; i < n; i++) if (bias[i] > 0) { total += bias[i]; live++; }
    for (let i = 0; i < n; i++) bias[i] *= live / (total || 1);
    return bias;
  }

  function finalize(ds) {
    const { n, counts } = ds;
    ds.binLen = Float64Array.from(ds.binEnd, (e, b) => Math.max(1, e - ds.binStart[b]));
    ds.bias = balance(counts, n);
    ds.masked = ds.bias.reduce((m, b) => m + (b > 0 ? 0 : 1), 0);
    // contacts of masked (poorly covered) bins carry no information for scoring
    ds.obs = counts;
    if (ds.masked) {
      ds.obs = counts.slice();
      for (let i = 0; i < n; i++) if (!(ds.bias[i] > 0)) for (let j = 0; j < n; j++) ds.obs[i * n + j] = ds.obs[j * n + i] = 0;
      ds.notes.push(`${ds.masked} poorly covered bins are masked (grey stripes) and ignored by the score.`);
    }
    ds.total = 0; ds.used = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { ds.total += counts[i * n + j]; ds.used += ds.obs[i * n + j]; }
    ds.genome = ds.binLen.reduce((a, b) => a + b, 0);
    if (ds.seqs) {
      ds.gc = new Float32Array(n).fill(NaN);
      for (let b = 0; b < n; b++) {
        const seq = ds.seqs.get(ds.contigs[ds.binContig[b]].name);
        if (!seq) continue;
        let gc = 0, at = 0;
        for (let p = ds.binStart[b], e = Math.min(seq.length, ds.binEnd[b]); p < e; p++) {
          const ch = seq[p] & 0xDF;
          if (ch === 71 || ch === 67) gc++; else if (ch === 65 || ch === 84) at++;
        }
        if (gc + at) ds.gc[b] = gc / (gc + at);
      }
    }
    return ds;
  }

  /* ───────────── layout: order, orientation, scaffold breaks ─────────────
     codes[p] = bin * 2 + reversed; cuts[p] = 1 when a scaffold starts at p;
     positions >= debris hold unplaced pieces. Layouts are immutable. */

  function initialLayout(ds) {
    const codes = Int32Array.from({ length: ds.n }, (_, b) => b * 2), cuts = new Uint8Array(ds.n + 1);
    for (const c of ds.contigs) cuts[c.first] = 1;
    cuts[ds.n] = 1;
    return { codes, cuts, debris: ds.n };
  }

  function assemble(L, pieces, debris) {
    const n = L.codes.length, codes = new Int32Array(n), cuts = new Uint8Array(n + 1);
    let o = 0, carry = 0;
    for (const { a, b, rev, cut } of pieces) {
      carry |= cut;
      if (a === b) continue;
      cuts[o] = carry; carry = 0;
      for (let k = 0, len = b - a; k < len; k++) {
        codes[o + k] = rev ? L.codes[b - 1 - k] ^ 1 : L.codes[a + k];
        if (k) cuts[o + k] = rev ? L.cuts[b - k] : L.cuts[a + k];
      }
      o += b - a;
    }
    cuts[0] = cuts[n] = cuts[debris] = 1;
    return { codes, cuts, debris };
  }

  const ops = {
    invert(L, a, b) {
      const n = L.codes.length;
      return assemble(L, [{ a: 0, b: a }, { a, b, rev: true, cut: L.cuts[a] }, { a: b, b: n, cut: L.cuts[b] }], L.debris);
    },
    /** Move [a,b) so it starts at boundary t. Dropped on a scaffold break it stays a separate scaffold; dropped inside a scaffold it becomes part of it. */
    move(L, a, b, t) {
      if (t >= a && t <= b) return L;
      const n = L.codes.length, sep = L.cuts[t], heal = L.cuts[a] | L.cuts[b];
      const debris = L.debris - Math.max(0, Math.min(b, L.debris) - a) + (t <= L.debris ? b - a : 0);
      return assemble(L, t < a
        ? [{ a: 0, b: t }, { a, b, cut: sep }, { a: t, b: a, cut: sep }, { a: b, b: n, cut: heal }]
        : [{ a: 0, b: a }, { a: b, b: t, cut: heal }, { a, b, cut: sep }, { a: t, b: n, cut: sep }], debris);
    },
    swap(L, a, b, c, d) {
      if (c < a) [a, b, c, d] = [c, d, a, b];
      if (b > c) return L;
      const n = L.codes.length, debris = L.debris + (a < L.debris && c >= L.debris ? (d - c) - (b - a) : 0);
      return assemble(L, [{ a: 0, b: a }, { a: c, b: d, cut: L.cuts[a] }, { a: b, b: c, cut: L.cuts[b] }, { a, b, cut: L.cuts[c] }, { a: d, b: n, cut: L.cuts[d] }], debris);
    },
    cut(L, p) {
      if (L.cuts[p]) return L;
      const cuts = L.cuts.slice();
      cuts[p] = 1;
      return { codes: L.codes, cuts, debris: L.debris };
    },
    join(L, p) {
      if (p <= 0 || p >= L.codes.length || p === L.debris || !L.cuts[p]) return L;
      const cuts = L.cuts.slice();
      cuts[p] = 0;
      return { codes: L.codes, cuts, debris: L.debris };
    },
    /** Take [a,b) out of the assembly; it is kept as an unplaced piece at the end. */
    unplace(L, a, b) {
      if (a >= L.debris) return L;
      return assemble(L, [{ a: 0, b: a }, { a: b, b: L.codes.length, cut: L.cuts[a] | L.cuts[b] }, { a, b, cut: 1 }], L.debris - (b - a));
    },
    /** Put unplaced [a,b) back into the assembly as its own scaffold, after the placed ones. */
    place(L, a, b) {
      if (a < L.debris) return L;
      if (a > L.debris) return ops.move(L, a, b, L.debris);
      const cuts = L.cuts.slice();
      cuts[b] = 1;
      return { codes: L.codes, cuts, debris: b };
    },
    /** Bring scaffold B next to scaffold A so that endB touches endA ('head' | 'tail'), then fuse them. A stays put. */
    joinEnds(L, A, endA, B, endB) {
      const tail = endA === 'tail', len = B.b - B.a, t = tail ? A.b : A.a;
      const flipped = (endB === 'tail') === tail ? ops.invert(L, B.a, B.b) : L;
      const moved = ops.move(flipped, B.a, B.b, t), at = t <= B.a ? t : t - len;
      return ops.join(moved, tail ? at : at + len);
    }
  };

  /** Scaffold list plus per-position lookup tables (scaffold index, bp offset inside the scaffold). */
  function geometry(ds, L) {
    const n = ds.n, scaf = new Int32Array(n), off = new Float64Array(n), list = [];
    let placed = 0, loose = 0;
    for (let p = 0, a = 0, len = 0; p < n; p++) {
      off[p] = len; scaf[p] = list.length;
      len += ds.binLen[L.codes[p] >> 1];
      if (L.cuts[p + 1]) {
        const ok = a < L.debris;
        list.push({ a, b: p + 1, len, placed: ok, name: ok ? `scaffold_${++placed}` : `unplaced_${++loose}` });
        a = p + 1; len = 0;
      }
    }
    return { scaf, off, list };
  }

  const contiguous = (ds, c1, c2) => (c1 & 1) === (c2 & 1) && (c2 >> 1) - (c1 >> 1) === (c1 & 1 ? -1 : 1) &&
    ds.binContig[c1 >> 1] === ds.binContig[c2 >> 1];

  /** 1 at every position where a scaffold or a piece collinear with an input contig starts (length n + 1). */
  function pieceEdges(ds, L) {
    const e = L.cuts.slice();
    for (let p = 1; p < ds.n; p++) if (!contiguous(ds, L.codes[p - 1], L.codes[p])) e[p] = 1;
    return e;
  }

  /** Maximal stretches of [a,b) that are collinear with an input contig. */
  function runs(ds, L, a, b) {
    const out = [];
    for (let p = a, s = a; p < b; p++) {
      if (p + 1 < b && contiguous(ds, L.codes[p], L.codes[p + 1])) continue;
      const first = L.codes[s] >> 1, last = L.codes[p] >> 1, rev = L.codes[s] & 1;
      out.push({ a: s, b: p + 1, rev, contig: ds.contigs[ds.binContig[first]].name, start: ds.binStart[rev ? last : first], end: ds.binEnd[rev ? first : last] });
      s = p + 1;
    }
    return out;
  }

  function stats(ds, L) {
    const { list } = geometry(ds, L), placed = list.filter(s => s.placed), lens = placed.map(s => s.len).sort((x, y) => y - x);
    const total = lens.reduce((x, y) => x + y, 0);
    let acc = 0, n50 = 0, l50 = 0;
    for (const len of lens) { acc += len; l50++; if (acc >= total / 2) { n50 = len; break; } }
    const out = { scaffolds: placed.length, unplaced: list.length - placed.length, total, unplacedBp: ds.genome - total, n50, l50, longest: lens[0] || 0,
      breakpoints: placed.reduce((s, x) => s + runs(ds, L, x.a, x.b).length - 1, 0) };
    if (ds.truth) {
      // adjacencies agree with the truth when consecutive bins are neighbours there, in a consistent orientation
      let good = 0, bad = 0;
      for (let p = 1; p < L.debris; p++) {
        if (L.cuts[p]) continue;
        const c1 = L.codes[p - 1], c2 = L.codes[p], i = c1 >> 1, j = c2 >> 1, t = ds.truth;
        const step = t.pos[j] - t.pos[i], fwd = (c1 & 1) ^ t.rev[i];
        if (t.chrom[i] === t.chrom[j] && step === (fwd ? -1 : 1) && ((c2 & 1) ^ t.rev[j]) === fwd) good++; else bad++;
      }
      const need = ds.n - ds.truth.chroms;
      Object.assign(out, { recall: good / need, misjoins: bad, missing: need - good });
    }
    return out;
  }

  /* ───────────── distance law ───────────── */

  /** Log-binned contact rate vs genomic distance for bin pairs sharing a scaffold, plus the inter-scaffold rate. */
  function distanceProfile(ds, L) {
    const { n, obs: counts, bias, binLen } = ds;
    let minLen = Infinity;
    for (let b = 0; b < n; b++) minLen = Math.min(minLen, binLen[b]);
    const lnS0 = Math.log(minLen) - 1e-9, size = Math.ceil((Math.log(ds.genome) - lnS0) * COARSE) + 2;
    const num = new Float64Array(size), den = new Float64Array(size), mid = new Float64Array(n);
    let cisNum = 0, cisDen = 0, sb = 0, sb2 = 0;
    for (let b = 0; b < n; b++) { sb += bias[b]; sb2 += bias[b] * bias[b]; }
    for (let a = 0, p = 1; p <= n; p++) {
      if (!L.cuts[p]) continue;
      for (let x = a, pos = 0; x < p; x++) { const len = binLen[L.codes[x] >> 1]; mid[x] = pos + len / 2; pos += len; }
      for (let x = a; x < p; x++) {
        const i = L.codes[x] >> 1, row = i * n, bi = bias[i];
        for (let y = x + 1; y < p; y++) {
          const j = L.codes[y] >> 1, k = ((Math.log(mid[y] - mid[x]) - lnS0) * COARSE) | 0, c = counts[row + j], w = bi * bias[j];
          num[k] += c; den[k] += w; cisNum += c; cisDen += w;
        }
      }
      a = p;
    }
    const points = [];
    for (let k = 0; k < size; k++) if (den[k] > 0) points.push({ s: Math.exp(lnS0 + (k + 0.5) / COARSE), p: num[k] / den[k], n: num[k], w: den[k] });
    const transDen = (sb * sb - sb2) / 2 - cisDen;
    return { points, trans: transDen > 1e-9 ? { n: ds.used - cisNum, w: transDen } : null };
  }

  /** Empirical, monotone P(s) with a power-law tail and a trans floor; frozen so that scores stay comparable across edits. */
  function fitModel(ds, L) {
    const { points, trans } = distanceProfile(ds, L);
    // slope: least squares in log-log space over well-supported distance bins
    const solid = points.filter(q => q.n >= 8 && q.p > 0);
    let alpha = 1;
    if (solid.length >= 3) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const q of solid) { const x = Math.log(q.s), y = Math.log(q.p); sx += x; sy += y; sxx += x * x; sxy += x * y; }
      const m = solid.length, slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
      if (Number.isFinite(slope)) alpha = Math.min(3, Math.max(0.3, -slope));
    }
    // pool adjacent violators: contact rate may not increase with distance
    const blocks = [];
    for (const q of points) {
      let blk = { n: q.n, w: q.w, count: 1 };
      while (blocks.length && blocks[blocks.length - 1].n / blocks[blocks.length - 1].w < blk.n / blk.w) {
        const prev = blocks.pop();
        blk = { n: prev.n + blk.n, w: prev.w + blk.w, count: prev.count + blk.count };
      }
      blocks.push(blk);
    }
    const mono = blocks.flatMap(blk => Array(blk.count).fill(blk.n / blk.w));
    const positive = mono.filter(v => v > 0), fallback = !positive.length;
    const pT = trans ? (trans.n + 0.5) / trans.w : fallback ? 1e-9 : positive[positive.length - 1] / 4;
    const lnS0 = fallback ? Math.log(ds.genome / ds.n / 2) : Math.log(points[0].s) - 0.5 / COARSE;
    const lnP = s => {
      if (fallback) return Math.log(pT * 50) - (Math.log(s) - lnS0 - Math.LN2);
      const x = Math.log(s), last = points.length - 1;
      if (x <= Math.log(points[0].s)) return Math.log(Math.max(mono[0], pT));
      let k = 0;
      while (k < last && Math.log(points[k + 1].s) < x) k++;
      const y0 = Math.log(Math.max(mono[k], pT));
      if (k === last) return y0 - alpha * (x - Math.log(points[last].s));
      const x0 = Math.log(points[k].s), x1 = Math.log(points[k + 1].s);
      return y0 + (Math.log(Math.max(mono[k + 1], pT)) - y0) * (x - x0) / (x1 - x0);
    };
    const lnPT = Math.log(pT), size = Math.ceil((Math.log(ds.genome) + 1 - lnS0) * FINE) + 1;
    const dl = new Float64Array(size), dp = new Float64Array(size);
    let sCut = Infinity;
    for (let k = 0; k < size - 1; k++) {
      const s = Math.exp(lnS0 + (k + 0.5) / FINE), v = Math.max(lnPT, lnP(s));
      if (v === lnPT) { sCut = Math.exp(lnS0 + k / FINE); break; }
      dl[k] = v - lnPT; dp[k] = Math.exp(v) - pT;
    }
    return { alpha, pT, lnPT, lnS0, dl, dp, sCut, last: size - 1, fallback, P: s => Math.exp(Math.max(lnPT, lnP(s))) };
  }

  /* ───────────── likelihood ─────────────
     n_ij ~ Poisson(b_i b_j P(s_ij)) inside a scaffold and Poisson(b_i b_j P_trans) across scaffolds, so
     ln L = base + Σ_scaffolds Σ_{i<j} [ n_ij (ln P(s) − ln P_trans) − b_i b_j (P(s) − P_trans) ].           */

  class Scorer {
    constructor(ds, model) {
      const { n, obs: counts, bias } = ds;
      Object.assign(this, { ds, model, mid: new Float64Array(n + 1), cache: new Map() });
      let sb = 0, sb2 = 0, base = 0;
      for (let b = 0; b < n; b++) { sb += bias[b]; sb2 += bias[b] * bias[b]; }
      for (let i = 0; i < n; i++) for (let j = i + 1, row = i * n; j < n; j++) {
        const c = counts[row + j];
        if (c > 0) base += c * (Math.log(bias[i] * bias[j]) + model.lnPT) - lnFact(c);
      }
      this.base = base - model.pT * (sb * sb - sb2) / 2;
    }

    /** Fill this.mid with bin midpoints (bp from the scaffold start) for positions [a,b); returns the length. */
    mids(codes, a, b) {
      let pos = 0;
      for (let x = a; x < b; x++) { const len = this.ds.binLen[codes[x] >> 1]; this.mid[x - a] = pos + len / 2; pos += len; }
      return pos;
    }

    index(s) {
      const k = ((Math.log(s) - this.model.lnS0) * FINE) | 0;
      return k < 0 ? 0 : k > this.model.last ? this.model.last : k;
    }

    /** Cis gain of one scaffold (memoised on its content). */
    intra(codes, a, b) {
      if (b - a < 2) return 0;
      let h1 = 0x811c9dc5, h2 = 0x1b873593;
      for (let x = a; x < b; x++) { h1 = Math.imul(h1 ^ codes[x], 0x01000193); h2 = Math.imul(h2 + codes[x], 0x85ebca6b) ^ (h2 >>> 13); }
      const key = (h1 >>> 0) * 2097152 + (h2 >>> 11), hit = this.cache.get(key);
      if (hit !== undefined) return hit;
      const { n, obs: counts, bias } = this.ds, { dl, dp, sCut } = this.model, mid = this.mid, len = b - a;
      this.mids(codes, a, b);
      let g = 0;
      for (let x = 0; x < len; x++) {
        const i = codes[a + x] >> 1, row = i * n, bi = bias[i], mx = mid[x];
        for (let y = x + 1; y < len; y++) {
          const s = mid[y] - mx;
          if (s > sCut) break;
          const j = codes[a + y] >> 1, k = this.index(s);
          g += counts[row + j] * dl[k] - bi * bias[j] * dp[k];
        }
      }
      if (this.cache.size > 20000) this.cache.clear();
      this.cache.set(key, g);
      return g;
    }

    /** Log-likelihood of a layout. */
    score(L) {
      let g = this.base;
      for (let a = 0, p = 1; p <= this.ds.n; p++) if (L.cuts[p]) { g += this.intra(L.codes, a, p); a = p; }
      return g;
    }

    /** Per-junction support: log2(observed / expected) contacts across each junction within ±w bins of the same scaffold. */
    junctions(L, w) {
      const { n, obs: counts, bias } = this.ds, { dp, pT } = this.model, ratio = new Float32Array(n + 1).fill(NaN), mid = this.mid;
      w = w || Math.min(24, Math.max(4, Math.round(n / 40)));
      for (let a = 0, e = 1; e <= n; e++) {
        if (!L.cuts[e]) continue;
        this.mids(L.codes, a, e);
        for (let p = a + 1; p < e; p++) {
          let obs = 0, exp = 0;
          for (let x = Math.max(a, p - w); x < p; x++) {
            const i = L.codes[x] >> 1, row = i * n, bi = bias[i];
            for (let y = p, top = Math.min(e, p + w); y < top; y++) {
              const j = L.codes[y] >> 1;
              obs += counts[row + j]; exp += bi * bias[j] * (dp[this.index(mid[y - a] - mid[x - a])] + pT);
            }
          }
          ratio[p] = Math.log2((obs + 0.5) / (exp + 0.5));
        }
        a = e;
      }
      const weak = [], reach = Math.max(2, w >> 1);
      for (let p = 1; p < n; p++) {
        if (!(ratio[p] < -0.8)) continue;
        let lowest = true;
        for (let q = Math.max(1, p - reach); q <= Math.min(n - 1, p + reach) && lowest; q++) if (ratio[q] < ratio[p] || (ratio[q] === ratio[p] && q < p)) lowest = false;
        if (lowest) weak.push(p);
      }
      weak.sort((p, q) => ratio[p] - ratio[q]);
      return { ratio, weak, w };
    }

    /** Approximate gain of fusing two scaffold ends, from the bins within `reach` of each end. */
    endGain(L, A, endA, B, endB, reach = 48) {
      const { n, obs: counts, bias, binLen } = this.ds, { dl, dp, sCut } = this.model;
      const side = (S, end) => {
        const bins = [], dist = [];
        for (let k = 0, pos = 0; k < Math.min(reach, S.b - S.a); k++) {
          const bin = L.codes[end === 'tail' ? S.b - 1 - k : S.a + k] >> 1;
          bins.push(bin); dist.push(pos + binLen[bin] / 2); pos += binLen[bin];
        }
        return { bins, dist };
      };
      const u = side(A, endA), v = side(B, endB);
      let g = 0;
      for (let x = 0; x < u.bins.length; x++) {
        const i = u.bins[x], row = i * n, bi = bias[i];
        for (let y = 0; y < v.bins.length; y++) {
          const s = u.dist[x] + v.dist[y];
          if (s > sCut) break;
          const k = this.index(s);
          g += counts[row + v.bins[y]] * dl[k] - bi * bias[v.bins[y]] * dp[k];
        }
      }
      return g;
    }

    /** Generator of edit hints, each scored exactly as Δ ln L. Drive it with next() in time slices; its return value is the ranked list. */
    *suggest(L, { maxWeak = 40, maxBlocks = 48, partners = 4 } = {}) {
      const ds = this.ds, { n, obs: counts, bias } = ds, geo = geometry(ds, L), list = geo.list, S = list.length;
      const base = this.score(L), J = this.junctions(L), out = [];
      const where = p => `${list[geo.scaf[p]].name} at ${fmtBp(geo.off[p])}`;
      const consider = (type, label, layout, focus) => {
        if (layout === L) return;
        const delta = this.score(layout) - base;
        if (delta > 0.5) out.push({ type, label, delta, layout, focus });
      };
      const weak = J.weak.slice(0, maxWeak);
      for (const p of weak) { consider('cut', `Cut ${where(p)}`, ops.cut(L, p), [p - 1, p + 1]); yield; }

      // blocks bounded by weak junctions and collinearity breaks: flip each one, and trade neighbours
      const marks = new Set(weak);
      for (let p = 1; p < n; p++) if (!L.cuts[p] && !contiguous(ds, L.codes[p - 1], L.codes[p])) marks.add(p);
      for (const sc of list) {
        let inner = [...marks].filter(p => p > sc.a && p < sc.b);
        if (inner.length > maxBlocks) inner = inner.sort((p, q) => J.ratio[p] - J.ratio[q]).slice(0, maxBlocks);
        const edge = [sc.a, ...inner.sort((p, q) => p - q), sc.b];
        for (let k = 0; k + 1 < edge.length && edge.length > 2; k++) {
          const [p, q, r] = [edge[k], edge[k + 1], edge[k + 2]];
          consider('invert', `Invert ${sc.name} ${fmtBp(geo.off[p])} to ${fmtBp(geo.off[q - 1] + ds.binLen[L.codes[q - 1] >> 1])}`, ops.invert(L, p, q), [p, q]);
          if (r !== undefined) consider('swap', `Swap neighbouring blocks in ${where(q)}`, ops.swap(L, p, q, q, r), [p, r]);
          yield;
        }
      }

      if (S > 1 && S <= 4000) {
        // scaffold-to-scaffold contact density picks the partners worth testing
        const link = new Float64Array(S * S), mass = new Float64Array(S);
        for (let x = 0; x < n; x++) {
          const i = L.codes[x] >> 1, row = i * n, sx = geo.scaf[x] * S;
          mass[geo.scaf[x]] += bias[i];
          for (let y = x + 1; y < n; y++) if (geo.scaf[y] * S !== sx) link[sx + geo.scaf[y]] += counts[row + (L.codes[y] >> 1)];
        }
        yield;
        const dens = (u, v) => (link[u * S + v] + link[v * S + u]) / (mass[u] * mass[v] || 1), seen = new Set(), ends = [];
        for (let u = 0; u < S; u++) {
          const best = Array.from({ length: S }, (_, v) => v).filter(v => v !== u && dens(u, v) > 0).sort((v, w) => dens(u, w) - dens(u, v)).slice(0, partners);
          for (const v of best) {
            // ends: A is the placed (or longer) scaffold that stays where it is
            const [ia, ib] = list[u].placed !== list[v].placed ? (list[u].placed ? [u, v] : [v, u]) : list[u].len >= list[v].len ? [u, v] : [v, u];
            if (seen.has(ia * S + ib)) continue;
            seen.add(ia * S + ib);
            const A = list[ia], B = list[ib];
            if (A.placed) for (const endA of ['tail', 'head']) for (const endB of ['head', 'tail']) {
              const gain = this.endGain(L, A, endA, B, endB);
              if (gain > 0) ends.push({ gain, A, endA, B, endB });
            }
            // insertion: B goes where its contacts with A peak, in both orientations
            if (A.placed && A.b - A.a > 1) {
              let at = -1, top = 0, prev = 0;
              for (let x = A.a; x < A.b; x++) {
                const col = L.codes[x] >> 1;
                let c = 0;
                for (let y = B.a; y < B.b; y++) c += counts[(L.codes[y] >> 1) * n + col];
                c /= bias[col] || 1;
                if (x > A.a && prev + c > top) { top = prev + c; at = x; }
                prev = c;
              }
              if (at > 0) for (const src of [L, ops.invert(L, B.a, B.b)])
                consider('insert', `Insert ${B.name}${src === L ? '' : ' (flipped)'} into ${where(at)}`, ops.move(src, B.a, B.b, at), [Math.min(at, B.a), Math.max(at, B.b)]);
            }
            yield;
          }
        }
        for (const e of ends.sort((x, y) => y.gain - x.gain).slice(0, 16)) {
          consider('join', `Join ${e.A.name} ${e.endA} to ${e.B.name} ${e.endB}`, ops.joinEnds(L, e.A, e.endA, e.B, e.endB), [Math.min(e.A.a, e.B.a), Math.max(e.A.b, e.B.b)]);
          yield;
        }
      }
      return { hints: out.sort((x, y) => y.delta - x.delta).slice(0, 14), junctions: J };
    }
  }

  /* ───────────── import of existing layouts ───────────── */

  function layoutFromAgp(ds, rows) {
    const byName = new Map(ds.contigs.map(c => [c.name, c])), used = new Uint8Array(ds.n), codes = [], cuts = [];
    let obj = null;
    for (const r of rows) {
      const ctg = byName.get(r.comp);
      if (!ctg) throw new Error(`The AGP names component ${r.comp}, which is not a contig of the loaded map.`);
      const hit = [];
      for (let b = ctg.first; b < ctg.first + ctg.count; b++) {
        const m = (ds.binStart[b] + ds.binEnd[b]) / 2;
        if (m >= r.beg && m < r.end && !used[b]) { hit.push(b * 2 + (r.rev ? 1 : 0)); used[b] = 1; }
      }
      if (r.rev) hit.reverse();
      if (hit.length && r.obj !== obj) cuts.push(codes.length);
      if (hit.length) obj = r.obj;
      codes.push(...hit);
    }
    const debris = codes.length;
    for (let b = 0; b < ds.n; b++) if (!used[b]) { if (!b || used[b - 1] || ds.binContig[b] !== ds.binContig[b - 1]) cuts.push(codes.length); codes.push(b * 2); }
    return layoutFromArrays(ds, codes, cuts, debris);
  }

  function layoutFromArrays(ds, codes, cutList, debris) {
    const seen = new Uint8Array(ds.n), cuts = new Uint8Array(ds.n + 1);
    if (codes.length !== ds.n || codes.some(c => !(c >> 1 < ds.n) || c < 0 || seen[c >> 1]++)) throw new Error('This layout does not match the loaded map: it must place each bin exactly once.');
    for (const p of cutList) cuts[p] = 1;
    cuts[0] = cuts[ds.n] = cuts[debris] = 1;
    return { codes: Int32Array.from(codes), cuts, debris };
  }

  const sessionOf = (ds, L, log) => ({ format: 'percival-session', version: 2, bins: ds.n, contacts: ds.total, codes: [...L.codes],
    cuts: [...L.cuts].flatMap((c, p) => c ? [p] : []), debris: L.debris, log });

  function layoutFromSession(ds, s) {
    if (s.bins !== ds.n || Math.abs(s.contacts - ds.total) > 1e-6 * ds.total) throw new Error(`This session was saved for a different map (${s.bins} bins, ${Math.round(s.contacts)} contacts).`);
    return layoutFromArrays(ds, s.codes, s.cuts, s.debris);
  }

  /* ───────────── exports ───────────── */

  const exporters = {
    /** AGP 2.1; pieces that are not collinear in the input are separated by 100 bp gaps of unknown size. */
    agp(ds, L) {
      const out = ['##agp-version\t2.1', '# Generated by Percival'];
      for (const sc of geometry(ds, L).list) {
        let pos = 0, part = 0;
        for (const r of runs(ds, L, sc.a, sc.b)) {
          if (part) { out.push([sc.name, pos + 1, pos + GAP, ++part, 'U', GAP, 'scaffold', 'yes', 'proximity_ligation'].join('\t')); pos += GAP; }
          const len = r.end - r.start;
          out.push([sc.name, pos + 1, pos + len, ++part, 'W', r.contig, r.start + 1, r.end, r.rev ? '-' : '+'].join('\t'));
          pos += len;
        }
      }
      return out.join('\n') + '\n';
    },
    /** BED6: where each input piece went (name = scaffold:start-end in the new assembly). */
    bed(ds, L) {
      const out = [];
      for (const sc of geometry(ds, L).list) {
        let pos = 0, part = 0;
        for (const r of runs(ds, L, sc.a, sc.b)) {
          if (part++) pos += GAP;
          const len = r.end - r.start;
          out.push([r.contig, r.start, r.end, `${sc.name}:${pos}-${pos + len}`, 0, r.rev ? '-' : '+'].join('\t'));
          pos += len;
        }
      }
      return out.join('\n') + '\n';
    },
    /** instaGRAAL-style info_frags.txt: one line per bin, ids are 1-based within the input contig. */
    infoFrags(ds, L) {
      const out = [];
      for (const sc of geometry(ds, L).list) {
        out.push(`>${sc.name}`, 'init_contig\tid_frag\torientation\tstart\tend');
        for (let p = sc.a; p < sc.b; p++) {
          const b = L.codes[p] >> 1, ctg = ds.contigs[ds.binContig[b]];
          out.push([ctg.name, b - ctg.first + 1, L.codes[p] & 1 ? -1 : 1, ds.binStart[b], ds.binEnd[b]].join('\t'));
        }
      }
      return out.join('\n') + '\n';
    },
    /** Reordered contacts as bg2 (upper triangle) in the coordinates of the new assembly. */
    bg2(ds, L) {
      const geo = geometry(ds, L), out = [], n = ds.n;
      const at = p => { const sc = geo.list[geo.scaf[p]]; return `${sc.name}\t${geo.off[p]}\t${geo.off[p] + ds.binLen[L.codes[p] >> 1]}`; };
      for (let x = 0; x < n; x++) for (let y = x, row = (L.codes[x] >> 1) * n; y < n; y++) {
        const v = ds.counts[row + (L.codes[y] >> 1)];
        if (v > 0) out.push(`${at(x)}\t${at(y)}\t${+v.toFixed(4)}`);
      }
      return out.join('\n') + '\n';
    },
    matrix(ds, L) {
      const n = ds.n, out = [];
      for (let x = 0; x < n; x++) {
        const row = (L.codes[x] >> 1) * n, cells = new Array(n);
        for (let y = 0; y < n; y++) cells[y] = +ds.counts[row + (L.codes[y] >> 1)].toFixed(4);
        out.push(cells.join('\t'));
      }
      return out.join('\n') + '\n';
    },
    /** FASTA of the edited assembly as an array of byte chunks (wrap 80, reverse complement applied, 100 N between pieces). */
    fasta(ds, L) {
      const chunks = [], enc = new TextEncoder(), comp = new Uint8Array(256).map((_, k) => k);
      'ACGTRYKMBVDHacgtrykmbvdh'.split('').forEach((ch, k) => { comp[ch.charCodeAt(0)] = 'TGCAYRMKVBHDtgcayrmkvbhd'.charCodeAt(k); });
      let line = new Uint8Array(81 * 4096), fill = 0, col = 0;
      const write = (get, len) => {
        for (let k = 0; k < len; k++) {
          line[fill++] = get(k);
          if (++col === 80) { line[fill++] = 10; col = 0; }
          if (fill >= line.length - 1) { chunks.push(line.subarray(0, fill)); line = new Uint8Array(81 * 4096); fill = 0; }
        }
      };
      for (const sc of geometry(ds, L).list) {
        if (col) { line[fill++] = 10; col = 0; }
        chunks.push(line.subarray(0, fill), enc.encode(`>${sc.name}\n`));
        line = new Uint8Array(81 * 4096); fill = 0;
        runs(ds, L, sc.a, sc.b).forEach((r, k) => {
          const seq = ds.seqs.get(r.contig), len = r.end - r.start;
          if (k) write(() => 78, GAP);
          write(!seq ? () => 78 : r.rev ? q => comp[seq[r.end - 1 - q]] || 78 : q => seq[r.start + q] || 78, len);
        });
      }
      if (col) line[fill++] = 10;
      chunks.push(line.subarray(0, fill));
      return chunks;
    }
  };

  /* ───────────── synthetic demo genomes ───────────── */

  /** kind: 'curation' (chromosome-scale scaffolds with planted errors) or 'scaffolding' (shuffled contigs). */
  function makeDemo(kind, seed = 11) {
    const rand = rng(seed), bs = 10000, sizes = [150, 120, 90, 60], N = sizes.reduce((a, b) => a + b, 0);
    const first = sizes.map((_, c) => sizes.slice(0, c).reduce((a, b) => a + b, 0));
    const tChrom = new Int32Array(N), tBias = new Float64Array(N), ab = new Float64Array(N), dom = new Int32Array(N);
    const cen = sizes.map(s => Math.round(s * (0.35 + 0.3 * rand())));
    for (let c = 0, t = 0, d = 0; c < sizes.length; c++) {
      let phase = rand() * 6, left = 0;
      for (let k = 0; k < sizes[c]; k++, t++) {
        tChrom[t] = c; tBias[t] = Math.exp(0.22 * gauss(rand)) * (rand() < 0.03 ? 0.35 : 1);
        ab[t] = Math.tanh(2.2 * Math.sin(phase + k / 4.5));
        if (left-- <= 0) { d++; left = 4 + Math.floor(rand() * 9); }
        dom[t] = d;
      }
    }
    const truthCounts = new Float32Array(N * N), C = 46, T = C * 0.004;
    for (let t = 0; t < N; t++) for (let u = t; u < N; u++) {
      const same = tChrom[t] === tChrom[u], d = u - t;
      const arm = Math.abs(t - first[tChrom[t]] - cen[tChrom[t]]) + Math.abs(u - first[tChrom[u]] - cen[tChrom[u]]);
      const trans = T * (1 + 3 * Math.exp(-arm / 9));
      const shape = Math.exp(0.3 * ab[t] * ab[u]) * (same && dom[t] === dom[u] ? 1.5 : 1);
      const lam = tBias[t] * tBias[u] * shape * (d === 0 ? C * 2.2 : same ? Math.max(C * Math.pow(d, -1.08), trans * 1.6) : trans);
      truthCounts[t * N + u] = truthCounts[u * N + t] = poisson(rand, lam);
    }
    // pieces of the true genome as [chrom, from, to, reversed], grouped into the input contigs
    let input;
    if (kind === 'curation') {
      input = [
        [[0, 0, 42], [0, 42, 78, 1], [0, 78, 112], [1, 84, 120]],
        [[1, 0, 30], [1, 56, 84], [1, 30, 56]],
        [[2, 0, 22], [2, 22, 47, 1], [2, 47, 64], [3, 0, 18, 1], [2, 64, 90]],
        [[3, 18, 60]],
        [[0, 112, 150, 1]]
      ];
    } else {
      input = [];
      sizes.forEach((len, c) => { for (let p = 0; p < len;) { const q = Math.min(len, p + 6 + Math.floor(rand() * 17)); input.push([[c, p, q, rand() < 0.5 ? 1 : 0]]); p = q; } });
      for (let k = input.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [input[k], input[j]] = [input[j], input[k]]; }
    }
    const pos = [], rev = [], chrom = [], start = [], end = [], seqs = new Map(), truthSeq = [];
    const letters = [65, 67, 71, 84];
    sizes.forEach((len, c) => {
      const seq = new Uint8Array(len * bs), phase = rand() * 6;
      for (let p = 0; p < seq.length; p++) {
        const gc = 0.4 + 0.03 * c + 0.09 * Math.sin(phase + p / (bs * 7)), r = rand();
        seq[p] = letters[r < gc ? 1 + (rand() < 0.5 ? 0 : 1) : rand() < 0.5 ? 0 : 3];
      }
      truthSeq.push(seq);
    });
    const comp = { 65: 84, 84: 65, 67: 71, 71: 67 };
    input.forEach((pieces, k) => {
      const name = (kind === 'curation' ? 'draft_' : 'ctg') + String(k + 1).padStart(2, '0'), bytes = new Bytes();
      let at = 0;
      for (const [c, from, to, flip] of pieces) {
        for (let q = from; q < to; q++) {
          pos.push(first[c] + (flip ? to - 1 - (q - from) : q)); rev.push(flip ? 1 : 0);
          chrom.push(name); start.push(at); end.push(at += bs);
        }
        const part = truthSeq[c].slice(from * bs, to * bs);
        bytes.push(flip ? part.reverse().map(x => comp[x]) : part);
      }
      seqs.set(name, bytes.done());
    });
    const data = new Float32Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) data[i * N + j] = truthCounts[pos[i] * N + pos[j]];
    const ds = build({ contacts: { n: N, data }, bins: { chrom, start, end }, fasta: { seqs } }, { maxBins: N });
    ds.truth = { pos: Int32Array.from(pos), rev: Uint8Array.from(rev), chrom: Int32Array.from(pos, t => tChrom[t]), chroms: sizes.length, seqs: truthSeq };
    ds.label = kind === 'curation' ? 'Demo: draft with planted errors' : 'Demo: shuffled contigs';
    return ds;
  }

  /** The correct layout of a demo dataset (for teaching and tests). */
  function truthLayout(ds) {
    const order = Array.from({ length: ds.n }, (_, b) => b).sort((x, y) => ds.truth.pos[x] - ds.truth.pos[y]);
    const cuts = order.flatMap((b, p) => p && ds.truth.chrom[b] !== ds.truth.chrom[order[p - 1]] ? [p] : []);
    return layoutFromArrays(ds, order.map(b => b * 2 + ds.truth.rev[b]), cuts, ds.n);
  }

  return { GAP, rng, fmtBp, lnFact, ingest, sniff, build, balance, initialLayout, ops, geometry, runs, pieceEdges, stats, distanceProfile, fitModel,
    Scorer, layoutFromAgp, layoutFromSession, sessionOf, exporters, makeDemo, truthLayout };
});
