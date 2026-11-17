/* Percival interface: map, tracks, editing, hints, analysis panels, loading and export. */
(() => {
  'use strict';
  const P = window.Percival, F = window.Fold3D;
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const fmtInt = v => Math.round(v).toLocaleString('en-US').replace(/,/g, ' ');
  const signed = v => (v >= 0.5 ? '+' : v <= -0.5 ? '−' : '') + fmtInt(Math.abs(v));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ───────────── state ───────────── */
  const S = {
    ds: null, L: null, scorer: null, startScore: 0, profile0: null, hist: [], hi: 0,
    sel: null, tool: 'select', moving: false, view: { x: 0, y: 0, k: 1 }, hover: null, preview: null,
    geo: null, edges: null, stats: null, junc: null, hints: [], hintJob: 0, hintsDone: false, auto: false,
    tab: 'hints', levels: null, image: null, staged: [], label: 'Demo'
  };
  const T = {}; // theme colours

  /* ───────────── colour ───────────── */
  const MAPS = {
    ligation: ['#FFFFFF', '#FCE6DF', '#F4A08B', '#E14A33', '#A8172A', '#4A0A1C'],
    ember: ['#0E151E', '#2B1531', '#6E1A3A', '#C9342E', '#F28B3C', '#FFE1A0', '#FFFBEA'],
    viridis: ['#440154', '#472D7B', '#3B528B', '#2C728E', '#21918C', '#28AE80', '#5EC962', '#ADDC30', '#FDE725'],
    ice: ['#FFFFFF', '#DDE8F6', '#93B6E6', '#4479D2', '#1D3D9C', '#0B1A48']
  };
  const hex = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
  const parseColor = s => {
    if (s.startsWith('#')) return hex(s.length === 4 ? '#' + [...s.slice(1)].map(c => c + c).join('') : s);
    const m = s.match(/[\d.]+/g) || [0, 0, 0];
    return m.slice(0, 3).map(Number);
  };
  function lut(stops) {
    const rgb = stops.map(s => Array.isArray(s) ? s : parseColor(s)), out = new Uint32Array(256);
    for (let k = 0; k < 255; k++) {
      const t = k / 254 * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(t)), f = t - i;
      const c = [0, 1, 2].map(a => Math.round(rgb[i][a] + (rgb[i + 1][a] - rgb[i][a]) * f));
      out[k] = 0xFF000000 | c[2] << 16 | c[1] << 8 | c[0];
    }
    return out;
  }
  function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
  }
  const rgbCss = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
  function refreshTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'surface', 'sunken', 'ink', 'muted', 'line', 'accent', 'signal', 'good', 'warn']) T[k] = cs.getPropertyValue('--' + k).trim();
    T.dark = parseColor(T.surface).reduce((a, b) => a + b, 0) < 300;
    T.fill = T.dark ? 'rgba(127,149,255,.13)' : 'rgba(39,71,214,.10)';
    T.mask = T.dark ? [30, 40, 52] : [205, 212, 220];
  }
  const contigColor = c => hsl((c * 137.508 + 18) % 360, T.dark ? 0.55 : 0.6, T.dark ? 0.6 : 0.5);
  const scafColor = (k, t) => hsl((k * 137.508 + 210) % 360, 0.58, (T.dark ? 0.74 : 0.66) - t * 0.34);

  /* ───────────── canvases ───────────── */
  const cv = { map: $('#map'), tracks: $('#tracks'), ribbon: $('#ribbon') };
  function fitCanvas(c) {
    const dpr = Math.min(3, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /* ───────────── matrix image ───────────── */
  function computeLevels() {
    const { n, counts, bias } = S.ds, mode = $('#mode').value, log = $('#scale').value === 'log';
    if (mode === 'oe') { S.levels = null; return; }
    const bal = mode === 'balanced', val = (i, j) => bal ? (bias[i] > 0 && bias[j] > 0 ? counts[i * n + j] / (bias[i] * bias[j]) : -1) : counts[i * n + j];
    const sample = [], stride = Math.max(1, Math.floor((n * n) / 2 / 250000));
    for (let i = 0, t = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (++t % stride === 0) { const v = val(i, j); if (v > 0) sample.push(v); }
    sample.sort((a, b) => a - b);
    const q = p => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))] || 1;
    const t = +$('#contrast').value / 100, vmax = q(1 - Math.pow(10, -(0.7 + 2.6 * t))), v0 = Math.max(vmax / 3000, q(0.02));
    const norm = log ? 254 / Math.log1p(vmax / v0) : 254 / vmax, lv = new Uint8Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
      const v = val(i, j);
      const l = v < 0 ? 255 : v <= 0 ? 0 : Math.min(254, Math.round(log ? Math.log1p(v / v0) * norm : v * norm));
      lv[i * n + j] = lv[j * n + i] = l;
    }
    S.levels = lv;
  }
  function currentLut() {
    const name = $('#cmap').value, key = name === 'auto' ? (T.dark ? 'ember' : 'ligation') : name, table = lut(MAPS[key]);
    table[255] = 0xFF000000 | T.mask[2] << 16 | T.mask[1] << 8 | T.mask[0];
    return table;
  }
  function paintImage() {
    const { n } = S.ds, perm = Int32Array.from(S.L.codes, c => c >> 1);
    if (!S.image || S.image.width !== n) { S.image = document.createElement('canvas'); S.image.width = S.image.height = n; }
    const ctx = S.image.getContext('2d'), img = ctx.createImageData(n, n), out = new Uint32Array(img.data.buffer);
    if (S.levels) {
      const table = currentLut(), lv = S.levels;
      for (let y = 0, o = 0; y < n; y++) { const row = perm[y] * n; for (let x = 0; x < n; x++) out[o++] = table[lv[row + perm[x]]]; }
    } else {
      // observed / expected under the frozen model, in the current layout
      const neg = parseColor(T.accent), pos = parseColor(T.signal), mid = parseColor(T.surface);
      const table = lut([neg, neg.map((c, a) => (c + mid[a]) / 2), mid, pos.map((c, a) => (c + mid[a]) / 2), pos]);
      table[255] = 0xFF000000 | T.mask[2] << 16 | T.mask[1] << 8 | T.mask[0];
      const { obs, bias } = S.ds, { dp, pT, sCut } = S.scorer.model, sc = S.scorer, geo = S.geo, mids = new Float64Array(n);
      for (let p = 0; p < n; p++) mids[p] = geo.off[p] + S.ds.binLen[perm[p]] / 2;
      for (let y = 0; y < n; y++) {
        const i = perm[y], bi = bias[i], row = i * n, sy = geo.scaf[y];
        for (let x = y; x < n; x++) {
          const j = perm[x];
          let l = 255;
          if (bi > 0 && bias[j] > 0) {
            const s = Math.abs(mids[x] - mids[y]), e = bi * bias[j] * (geo.scaf[x] === sy && x !== y && s <= sCut ? dp[sc.index(s)] + pT : pT);
            l = x === y ? 127 : clamp(Math.round(127 + 40 * Math.log2((obs[row + j] + 0.5) / (e + 0.5))), 0, 254);
          }
          out[y * n + x] = out[x * n + y] = table[l];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ───────────── view ───────────── */
  const sx = b => (b - S.view.x) * S.view.k, sy = b => (b - S.view.y) * S.view.k;
  function fitView() {
    const { clientWidth: w, clientHeight: h } = cv.map, n = S.ds.n, k = Math.min(w, h) * 0.97 / n;
    S.view = { k, x: -(w / k - n) / 2, y: -(h / k - n) / 2 };
    S.fitted = true;
    drawAll();
  }
  function zoomTo(a, b, c = a, d = b) {
    const { clientWidth: w, clientHeight: h } = cv.map, k = Math.min(w / (b - a), h / (d - c)) * 0.9;
    S.view = { k, x: (a + b) / 2 - w / k / 2, y: (c + d) / 2 - h / k / 2 };
    S.fitted = false;
    drawAll();
  }
  function zoomAt(px, py, factor) {
    const v = S.view, n = S.ds.n, w = cv.map.clientWidth, h = cv.map.clientHeight;
    const k = clamp(v.k * factor, Math.min(w, h) / n * 0.5, 80), bx = v.x + px / v.k, by = v.y + py / v.k;
    S.view = { k, x: bx - px / k, y: by - py / k };
    S.fitted = false;
    drawAll();
  }

  /* ───────────── drawing: map ───────────── */
  function drawMap() {
    const { ctx, w, h } = fitCanvas(cv.map), { n } = S.ds, { x, y, k } = S.view, L = S.L, geo = S.geo;
    ctx.fillStyle = T.sunken; ctx.fillRect(0, 0, w, h);
    const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(n, Math.ceil(x + w / k)), y0 = Math.max(0, Math.floor(y)), y1 = Math.min(n, Math.ceil(y + h / k));
    if (x1 > x0 && y1 > y0) {
      ctx.imageSmoothingEnabled = k < 1; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(S.image, x0, y0, x1 - x0, y1 - y0, sx(x0), sy(y0), (x1 - x0) * k, (y1 - y0) * k);
    }
    // scaffold blocks on the diagonal
    ctx.lineWidth = 1;
    for (const s of geo.list) {
      if (s.b < Math.min(x0, y0) || s.a > Math.max(x1, y1)) continue;
      ctx.strokeStyle = s.placed ? (T.dark ? 'rgba(229,235,241,.55)' : 'rgba(20,32,43,.5)') : T.muted;
      ctx.setLineDash(s.placed ? [] : [3, 3]);
      ctx.strokeRect(Math.round(sx(s.a)) + 0.5, Math.round(sy(s.a)) + 0.5, Math.round((s.b - s.a) * k), Math.round((s.b - s.a) * k));
    }
    ctx.setLineDash([]);
    if (L.debris < n) {
      ctx.strokeStyle = T.muted; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(sx(L.debris), 0); ctx.lineTo(sx(L.debris), h); ctx.moveTo(0, sy(L.debris)); ctx.lineTo(w, sy(L.debris)); ctx.stroke();
      ctx.setLineDash([]);
    }
    // piece edges inside scaffolds: ticks across the diagonal
    if (k > 0.6) {
      ctx.strokeStyle = T.dark ? 'rgba(229,235,241,.6)' : 'rgba(20,32,43,.55)';
      ctx.beginPath();
      for (let p = Math.max(1, Math.min(x0, y0)); p < Math.min(n, Math.max(x1, y1)); p++) if (S.edges[p] && !L.cuts[p]) {
        const px = sx(p), py = sy(p); ctx.moveTo(px - 5, py + 5); ctx.lineTo(px + 5, py - 5);
      }
      ctx.stroke();
    }
    // weak junctions
    for (const p of S.junc.weak.slice(0, 60)) {
      const px = sx(p), py = sy(p);
      if (px < -10 || py < -10 || px > w + 10 || py > h + 10) continue;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.lineWidth = 1.5; ctx.strokeStyle = T.signal; ctx.stroke();
    }
    // selection
    if (S.sel) {
      const { a, b } = S.sel;
      ctx.fillStyle = T.fill;
      ctx.fillRect(sx(a), 0, (b - a) * k, h); ctx.fillRect(0, sy(a), w, (b - a) * k);
      ctx.lineWidth = 2; ctx.strokeStyle = T.accent;
      ctx.strokeRect(sx(a), sy(a), (b - a) * k, (b - a) * k);
    }
    if (S.preview) {
      const [a, b] = S.preview;
      ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeStyle = T.accent;
      ctx.strokeRect(sx(a) - 3, sy(a) - 3, (b - a) * k + 6, (b - a) * k + 6);
      ctx.setLineDash([]);
    }
    // tool guides
    const g = S.hover && S.hover.guide;
    if (g !== undefined && g !== null) {
      ctx.strokeStyle = T.accent; ctx.lineWidth = 2;
      ctx.beginPath();
      if (S.moving) { ctx.moveTo(sx(g), 0); ctx.lineTo(sx(g), h); ctx.moveTo(0, sy(g)); ctx.lineTo(w, sy(g)); }
      else { const px = sx(g), py = sy(g); ctx.moveTo(px - 14, py + 14); ctx.lineTo(px + 14, py - 14); }
      ctx.stroke();
      ctx.beginPath(); ctx.arc(sx(g), sy(g), 4, 0, 7); ctx.fillStyle = T.accent; ctx.fill();
    }
  }

  /* ───────────── drawing: tracks ───────────── */
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function drawTracks() {
    const { ctx, w, h } = fitCanvas(cv.tracks), ds = S.ds, L = S.L, n = ds.n, { x, k } = S.view, geo = S.geo;
    ctx.clearRect(0, 0, w, h);
    const p0 = Math.max(0, Math.floor(x)), p1 = Math.min(n, Math.ceil(x + w / k)), rows = [];
    let top = 0;
    const row = (name, height) => { const r = { name, y: top, h: height }; rows.push(r); top += height + 4; return r; };
    const band = row('scaffolds', 16), ruler = row('ruler', 12), origin = row('origin', 10);
    const hasGc = !!ds.gc, free = h - top - 4;
    const cover = row('coverage', Math.round(free * (hasGc ? 0.34 : 0.5)) - 4), gc = hasGc ? row('GC', Math.round(free * 0.26) - 4) : null, support = row('support', h - top);

    ctx.font = '500 11px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'middle';
    // scaffold band
    geo.list.forEach((s, idx) => {
      if (s.b <= p0 || s.a >= p1) return;
      const X0 = Math.max(0, sx(s.a)), X1 = Math.min(w, sx(s.b)), on = S.sel && S.sel.a < s.b && S.sel.b > s.a;
      ctx.fillStyle = on ? T.accent : s.placed ? (idx % 2 ? (T.dark ? '#3A4A5E' : '#4A5B6C') : (T.dark ? '#536479' : '#6D7E8F')) : T.line;
      ctx.fillRect(X0 + 0.5, band.y, Math.max(1, X1 - X0 - 1), band.h);
      if (X1 - X0 > 46) {
        ctx.save(); ctx.beginPath(); ctx.rect(X0, band.y, X1 - X0 - 4, band.h); ctx.clip();
        ctx.fillStyle = s.placed || on ? '#FFFFFF' : T.ink; ctx.fillText(`${s.name}  ${P.fmtBp(s.len)}`, X0 + 6, band.y + band.h / 2 + 0.5);
        ctx.restore();
      }
    });
    // ruler in scaffold coordinates
    const bpPerPx = (ds.genome / n) / k, step = niceStep(bpPerPx * 80);
    ctx.strokeStyle = T.muted; ctx.fillStyle = T.muted; ctx.lineWidth = 1; ctx.textBaseline = 'alphabetic';
    ctx.beginPath();
    for (let p = p0; p < p1; p++) {
      const off = geo.off[p], end = off + ds.binLen[L.codes[p] >> 1], first = Math.ceil(off / step) * step;
      for (let t = first; t < end; t += step) {
        const X = sx(p) + (t - off) / (end - off) * k;
        ctx.moveTo(Math.round(X) + 0.5, ruler.y); ctx.lineTo(Math.round(X) + 0.5, ruler.y + (t ? 4 : 12));
        if (t) ctx.fillText(P.fmtBp(t), X + 3, ruler.y + 11);
      }
    }
    ctx.stroke();
    // input contig origin, striped when reversed
    for (const s of geo.list) {
      if (s.b <= p0 || s.a >= p1) continue;
      for (const r of P.runs(ds, L, Math.max(s.a, p0 - 1), Math.min(s.b, p1 + 1))) {
        const X0 = sx(r.a), W = Math.max(1, (r.b - r.a) * k - (k > 3 ? 1 : 0)), c = ds.binContig[L.codes[r.a] >> 1];
        ctx.fillStyle = rgbCss(contigColor(c)); ctx.fillRect(X0, origin.y, W, origin.h);
        if (r.rev && W > 3) {
          ctx.save(); ctx.beginPath(); ctx.rect(X0, origin.y, W, origin.h); ctx.clip();
          ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 1.5; ctx.beginPath();
          for (let q = X0 - origin.h; q < X0 + W; q += 5) { ctx.moveTo(q, origin.y + origin.h); ctx.lineTo(q + origin.h, origin.y); }
          ctx.stroke(); ctx.restore();
        }
      }
    }
    // coverage
    const cov = S.coverage;
    ctx.fillStyle = T.dark ? 'rgba(141,155,169,.55)' : 'rgba(90,103,116,.45)';
    ctx.beginPath(); ctx.moveTo(sx(p0), cover.y + cover.h);
    for (let p = p0; p < p1; p++) { const v = Math.min(1, cov[L.codes[p] >> 1] / S.coverTop), Y = cover.y + cover.h * (1 - v); ctx.lineTo(sx(p), Y); ctx.lineTo(sx(p + 1), Y); }
    ctx.lineTo(sx(p1), cover.y + cover.h); ctx.fill();
    ctx.fillStyle = T.signal;
    for (let p = p0; p < p1; p++) if (!(ds.bias[L.codes[p] >> 1] > 0)) ctx.fillRect(sx(p), cover.y + cover.h - 3, Math.max(1, k), 3);
    // GC
    if (gc) {
      const vals = [...ds.gc].filter(v => v === v), lo = Math.min(...vals), hi = Math.max(...vals);
      ctx.strokeStyle = T.good; ctx.lineWidth = 1.25; ctx.beginPath();
      let pen = false;
      for (let p = p0; p < p1; p++) {
        const v = ds.gc[L.codes[p] >> 1];
        if (v !== v) { pen = false; continue; }
        const Y = gc.y + gc.h * (1 - (v - lo) / ((hi - lo) || 1));
        if (pen) ctx.lineTo(sx(p + 0.5), Y); else ctx.moveTo(sx(p + 0.5), Y);
        pen = true;
      }
      ctx.stroke();
    }
    // junction support: log2 observed / expected across each point
    const zero = support.y + support.h * 0.4, unit = support.h * 0.6 / 3;
    ctx.fillStyle = T.line; ctx.fillRect(0, zero, w, 1);
    for (let p = Math.max(1, p0); p <= p1 && p < n; p++) {
      const r = S.junc.ratio[p];
      if (r !== r) continue;
      const v = clamp(r, -3, 1.2), X = sx(p) - Math.max(1, Math.min(4, k * 0.6)) / 2, Wd = Math.max(1, Math.min(4, k * 0.6));
      ctx.fillStyle = v < -0.8 ? T.signal : v < 0 ? T.warn : T.muted;
      ctx.globalAlpha = v < 0 ? 0.9 : 0.5;
      if (v < 0) ctx.fillRect(X, zero, Wd, -v * unit); else ctx.fillRect(X, zero - v * unit, Wd, v * unit);
    }
    ctx.globalAlpha = 1;
    if (S.sel) { ctx.fillStyle = T.fill; ctx.fillRect(sx(S.sel.a), 0, (S.sel.b - S.sel.a) * k, h); }
    // labels
    ctx.textBaseline = 'top'; ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    for (const r of [cover, gc, support].filter(Boolean)) {
      const label = r.name === 'support' ? 'junction support' : r.name, tw = ctx.measureText(label).width;
      ctx.fillStyle = T.surface; ctx.globalAlpha = 0.85; ctx.fillRect(2, r.y, tw + 8, 14); ctx.globalAlpha = 1;
      ctx.fillStyle = T.muted; ctx.fillText(label, 6, r.y + 1);
    }
  }
  function drawRibbon() {
    const { ctx, w, h } = fitCanvas(cv.ribbon), ds = S.ds, L = S.L, n = ds.n, { y, k } = S.view;
    ctx.clearRect(0, 0, w, h);
    const p0 = Math.max(0, Math.floor(y)), p1 = Math.min(n, Math.ceil(y + h / k));
    S.geo.list.forEach((s, idx) => {
      if (s.b <= p0 || s.a >= p1) return;
      const on = S.sel && S.sel.a < s.b && S.sel.b > s.a;
      ctx.fillStyle = on ? T.accent : s.placed ? (idx % 2 ? (T.dark ? '#3A4A5E' : '#4A5B6C') : (T.dark ? '#536479' : '#6D7E8F')) : T.line;
      ctx.fillRect(2, sy(s.a) + 0.5, 9, Math.max(1, (s.b - s.a) * k - 1));
      for (const r of P.runs(ds, L, Math.max(s.a, p0 - 1), Math.min(s.b, p1 + 1))) {
        ctx.fillStyle = rgbCss(contigColor(ds.binContig[L.codes[r.a] >> 1]));
        ctx.fillRect(14, sy(r.a), 8, Math.max(1, (r.b - r.a) * k - (k > 3 ? 1 : 0)));
      }
    });
  }

  let frame = 0;
  function drawAll() {
    if (frame || !S.ds) return;
    frame = requestAnimationFrame(() => { frame = 0; drawMap(); drawTracks(); drawRibbon(); });
  }

  /* ───────────── derived data and refresh ───────────── */
  function derive() {
    const ds = S.ds, L = S.L;
    S.geo = P.geometry(ds, L);
    S.edges = P.pieceEdges(ds, L);
    S.stats = P.stats(ds, L);
    S.junc = S.scorer.junctions(L);
  }
  function refresh({ repaint = true } = {}) {
    derive();
    if (repaint) paintImage();
    drawAll();
    renderScore(); renderFacts(); renderScaffolds(); renderHistory(); syncActions();
    scheduleHints();
    renderTab();
    autosave();
  }
  function renderScore() {
    const d = S.hist[S.hi].score - S.startScore, el = $('#score-value');
    el.textContent = signed(d);
    el.className = 'score-value' + (d > 0.5 ? ' up' : d < -0.5 ? ' down' : '');
  }
  function renderFacts() {
    const st = S.stats, items = [['Scaffolds', fmtInt(st.scaffolds)], ['N50', P.fmtBp(st.n50)]];
    if (st.unplaced) items.push(['Unplaced', fmtInt(st.unplaced)]);
    if (S.ds.truth) items.push(['Misjoins', st.misjoins, st.misjoins ? 'bad' : 'ok'], ['Missing joins', st.missing, st.missing ? 'bad' : 'ok']);
    else items.push(['Weak junctions', S.junc.weak.length, S.junc.weak.length ? 'bad' : 'ok']);
    $('#facts').innerHTML = items.map(([k, v, c]) => `<div class="${c || ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }
  function syncActions() {
    const has = !!S.sel;
    for (const id of ['#act-invert', '#act-move', '#act-excise', '#act-unplace']) $(id).disabled = !has;
    $('#act-unplace span').textContent = has && S.sel.a >= S.L.debris ? 'Place' : 'Unplace';
    $('#act-move').classList.toggle('armed', S.moving);
    $('#undo').disabled = S.hi === 0; $('#redo').disabled = S.hi >= S.hist.length - 1;
    const banner = $('#mode-banner');
    banner.hidden = !S.moving && S.tool === 'select';
    banner.textContent = S.moving ? 'Click where the selection should go. Esc cancels.' : S.tool === 'cut' ? 'Click a point on the diagonal to break the scaffold there.' : 'Click a scaffold edge on the diagonal to join it to its neighbour.';
  }

  /* ───────────── editing ───────────── */
  function commit(L, label, sel) {
    if (L === S.L || (L.debris === S.L.debris && L.codes.every((c, p) => c === S.L.codes[p]) && L.cuts.every((c, p) => c === S.L.cuts[p]))) {
      toast('That edit leaves the assembly unchanged.');
      return false;
    }
    S.hist = S.hist.slice(0, S.hi + 1);
    S.hist.push({ L, label, score: S.scorer.score(L) });
    if (S.hist.length > 500) S.hist.splice(1, 1);
    S.hi = S.hist.length - 1;
    S.L = L; S.sel = sel === undefined ? S.sel : sel; S.moving = false;
    refresh();
    return true;
  }
  function jump(i) {
    if (i < 0 || i >= S.hist.length || i === S.hi) return;
    S.hi = i; S.L = S.hist[i].L; S.moving = false;
    if (S.sel && S.sel.b > S.ds.n) S.sel = null;
    refresh();
  }
  const selRange = () => S.sel && [S.sel.a, S.sel.b];
  const where = p => { const s = S.geo.list[S.geo.scaf[Math.min(p, S.ds.n - 1)]]; return `${s.name} at ${P.fmtBp(S.geo.off[Math.min(p, S.ds.n - 1)])}`; };
  const span = (a, b) => `${P.fmtBp(S.geo.off[a])}–${P.fmtBp(S.geo.off[b - 1] + S.ds.binLen[S.L.codes[b - 1] >> 1])} of ${S.geo.list[S.geo.scaf[a]].name}`;
  const actions = {
    invert() { const r = selRange(); if (r) commit(P.ops.invert(S.L, ...r), `Invert ${span(...r)}`); },
    excise() { const r = selRange(); if (r) commit(P.ops.cut(P.ops.cut(S.L, r[0]), r[1]), `Excise ${span(...r)}`); },
    unplace() {
      const r = selRange(); if (!r) return;
      const len = r[1] - r[0];
      if (r[0] >= S.L.debris) commit(P.ops.place(S.L, r[0], r[1]), `Place ${S.geo.list[S.geo.scaf[r[0]]].name}`, { a: S.L.debris, b: S.L.debris + len });
      else commit(P.ops.unplace(S.L, ...r), `Unplace ${span(...r)}`, { a: S.ds.n - len, b: S.ds.n });
    },
    move() { if (S.sel) { S.moving = !S.moving; syncActions(); drawAll(); } },
    drop(t) {
      const { a, b } = S.sel, len = b - a;
      if (t >= a && t <= b) { toast('Drop the selection outside itself.'); return; }
      commit(P.ops.move(S.L, a, b, t), `Move ${span(a, b)} to ${t >= S.ds.n ? 'the end' : where(t)}`, { a: t <= a ? t : t - len, b: (t <= a ? t : t - len) + len });
    },
    cut(p) { if (p > 0 && p < S.ds.n) commit(P.ops.cut(S.L, p), `Break ${where(p)}`); },
    join(p) {
      if (p === S.L.debris) { toast('Unplaced pieces join the assembly with Place, not Join.'); return; }
      const before = S.geo.list[S.geo.scaf[p - 1]].name, after = S.geo.list[S.geo.scaf[p]].name;
      commit(P.ops.join(S.L, p), `Join ${before} to ${after}`);
    }
  };
  function setTool(t) {
    S.tool = t; S.moving = false;
    $$('.tool').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
    syncActions(); drawAll();
  }

  /* ───────────── map interaction ───────────── */
  const binAt = (px, axis = 'x') => (axis === 'x' ? S.view.x : S.view.y) + px / S.view.k;
  function snap(px, free) {
    const n = S.ds.n, raw = clamp(binAt(px), 0, n);
    if (free) return Math.round(raw);
    const reach = 9 / S.view.k, lo = Math.max(0, Math.floor(raw - reach)), hi = Math.min(n, Math.ceil(raw + reach));
    let best = -1;
    for (let p = lo; p <= hi; p++) if (S.edges[p] && (best < 0 || Math.abs(p - raw) < Math.abs(best - raw))) best = p;
    return best >= 0 && Math.abs(best - raw) <= reach ? best : Math.round(raw);
  }
  function nearestBreak(px) {
    const raw = binAt(px), reach = Math.max(2, 14 / S.view.k);
    let best = -1;
    for (let p = Math.max(1, Math.floor(raw - reach)); p <= Math.min(S.ds.n - 1, Math.ceil(raw + reach)); p++)
      if (S.L.cuts[p] && (best < 0 || Math.abs(p - raw) < Math.abs(best - raw))) best = p;
    return best < 0 ? null : best;
  }
  function describe(p) {
    const ds = S.ds, code = S.L.codes[p], bin = code >> 1, ctg = ds.contigs[ds.binContig[bin]], sc = S.geo.list[S.geo.scaf[p]];
    return { sc, off: S.geo.off[p], ctg, cpos: ds.binStart[bin], rev: code & 1, bin };
  }
  function updateHover(e) {
    const r = cv.map.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, n = S.ds.n;
    const bx = Math.floor(binAt(px)), by = Math.floor(binAt(py, 'y'));
    S.hover = { px, py, bx, by, guide: null };
    if (S.moving) S.hover.guide = snap(px, e.altKey);
    else if (S.tool === 'cut') { const p = snap(px, e.altKey); S.hover.guide = p > 0 && p < n && !S.L.cuts[p] ? p : null; }
    else if (S.tool === 'join') S.hover.guide = nearestBreak(px);
    const tip = $('#tip');
    if (bx < 0 || by < 0 || bx >= n || by >= n) { tip.hidden = true; $('#readout').textContent = 'Hover the map for coordinates'; drawAll(); return; }
    const A = describe(bx), B = describe(by), ds = S.ds, raw = ds.counts[A.bin * n + B.bin];
    const same = A.sc === B.sc, s = Math.abs(A.off - B.off), m = S.scorer.model;
    const expect = ds.bias[A.bin] * ds.bias[B.bin] * (same && bx !== by ? m.P(s) : m.pT), oe = expect > 0 ? (ds.obs[A.bin * n + B.bin] + 0.5) / (expect + 0.5) : NaN;
    const pos = d => `<b>${esc(d.sc.name)}</b> ${P.fmtBp(d.off)} <span>(${esc(d.ctg.name)} ${P.fmtBp(d.cpos)}${d.rev ? ', reversed' : ''})</span>`;
    $('#readout').innerHTML = `${pos(A)} &nbsp;×&nbsp; ${pos(B)} &nbsp; <b>${fmtInt(raw)}</b> contacts${oe === oe ? `, ${oe.toFixed(2)}× expected` : ''}${same && bx !== by ? `, ${P.fmtBp(s)} apart` : ''}`;
    tip.hidden = !!(S.drag && S.drag.kind === 'pan');
    tip.innerHTML = `${fmtInt(raw)} contacts${oe === oe ? `<br>${oe.toFixed(2)}× expected` : ''}`;
    tip.style.left = Math.min(px + 14, cv.map.clientWidth - 140) + 'px';
    tip.style.top = Math.min(py + 14, cv.map.clientHeight - 50) + 'px';
    drawAll();
  }
  const pointers = new Map();
  cv.map.addEventListener('contextmenu', e => e.preventDefault());
  cv.map.addEventListener('pointerdown', e => {
    if (!S.ds) return;
    cv.map.focus({ preventScroll: true });
    cv.map.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = cv.map.getBoundingClientRect(), px = e.clientX - r.left;
    if (pointers.size === 2) { S.drag = { kind: 'pinch', start: S.view, pts: [...pointers.values()] }; return; }
    if (e.button === 1 || e.button === 2 || S.space) { S.drag = { kind: 'pan', x: e.clientX, y: e.clientY, view: { ...S.view } }; cv.map.classList.add('panning'); return; }
    if (e.button !== 0) return;
    if (S.moving) { actions.drop(snap(px, e.altKey)); return; }
    if (S.tool === 'cut') { const p = snap(px, e.altKey); if (S.L.cuts[p]) toast('That point is already a scaffold edge.'); else actions.cut(p); return; }
    if (S.tool === 'join') { const p = nearestBreak(px); if (p) actions.join(p); else toast('Move closer to a scaffold edge on the diagonal.'); return; }
    const a = snap(px, e.altKey);
    S.drag = { kind: 'select', a, x: e.clientX, moved: false };
  });
  cv.map.addEventListener('pointermove', e => {
    if (!S.ds) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = S.drag;
    if (d && d.kind === 'pinch' && pointers.size === 2) {
      const [p, q] = [...pointers.values()], [p0, q0] = d.pts, r = cv.map.getBoundingClientRect();
      const f = Math.hypot(p.x - q.x, p.y - q.y) / (Math.hypot(p0.x - q0.x, p0.y - q0.y) || 1);
      const cx0 = (p0.x + q0.x) / 2 - r.left, cy0 = (p0.y + q0.y) / 2 - r.top, cx = (p.x + q.x) / 2 - r.left, cy = (p.y + q.y) / 2 - r.top;
      const k = clamp(d.start.k * f, 0.05, 80), bx = d.start.x + cx0 / d.start.k, by = d.start.y + cy0 / d.start.k;
      S.view = { k, x: bx - cx / k, y: by - cy / k };
      S.fitted = false;
      drawAll(); return;
    }
    if (d && d.kind === 'pan') {
      S.view = { ...d.view, x: d.view.x - (e.clientX - d.x) / S.view.k, y: d.view.y - (e.clientY - d.y) / S.view.k };
      S.fitted = false;
      drawAll(); return;
    }
    if (d && d.kind === 'select') {
      const r = cv.map.getBoundingClientRect();
      if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
      if (d.moved) {
        let b = snap(e.clientX - r.left, e.altKey), a = d.a;
        if (b === a) b = a + (e.clientX > d.x ? 1 : -1);
        let lo = clamp(Math.min(a, b), 0, S.ds.n - 1), hi = clamp(Math.max(a, b), lo + 1, S.ds.n);
        const deb = S.L.debris;
        if (lo < deb && hi > deb) { if (a <= deb) hi = deb; else lo = deb; }
        S.sel = { a: lo, b: hi };
        syncActions(); renderScaffoldsSelection();
      }
    }
    updateHover(e);
  });
  const release = e => {
    pointers.delete(e.pointerId);
    const d = S.drag;
    if (!d) return;
    if (d.kind === 'select' && !d.moved) { S.sel = null; syncActions(); renderScaffoldsSelection(); }
    if (d.kind === 'select' && d.moved) updateFoldSoon();
    if (pointers.size === 0 || d.kind !== 'pinch') { S.drag = null; cv.map.classList.remove('panning'); }
    drawAll();
  };
  cv.map.addEventListener('pointerup', release);
  cv.map.addEventListener('pointercancel', release);
  cv.map.addEventListener('pointerleave', () => { if (!S.drag) { S.hover = null; $('#tip').hidden = true; drawAll(); } });
  cv.map.addEventListener('wheel', e => {
    if (!S.ds) return;
    e.preventDefault();
    const r = cv.map.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    else { S.view.x += e.deltaX / S.view.k; S.fitted = false; drawAll(); }
  }, { passive: false });
  cv.map.addEventListener('dblclick', e => {
    const r = cv.map.getBoundingClientRect(), p = Math.floor(binAt(e.clientX - r.left));
    if (p < 0 || p >= S.ds.n) return;
    const s = S.geo.list[S.geo.scaf[p]];
    S.sel = { a: s.a, b: s.b }; syncActions(); renderScaffoldsSelection(); drawAll(); updateFoldSoon();
  });
  // tracks: drag there selects too, with the same snapping
  cv.tracks.addEventListener('pointerdown', e => {
    if (!S.ds || e.button !== 0) return;
    const r = cv.tracks.getBoundingClientRect(), a = snap(e.clientX - r.left, e.altKey);
    cv.tracks.setPointerCapture(e.pointerId);
    S.trackDrag = { a, x: e.clientX };
  });
  cv.tracks.addEventListener('pointermove', e => {
    const d = S.trackDrag; if (!d || Math.abs(e.clientX - d.x) < 3) return;
    const r = cv.tracks.getBoundingClientRect(), b = snap(e.clientX - r.left, e.altKey);
    const lo = clamp(Math.min(d.a, b), 0, S.ds.n - 1), hi = clamp(Math.max(d.a, b), lo + 1, S.ds.n);
    S.sel = { a: lo, b: lo < S.L.debris && hi > S.L.debris ? S.L.debris : hi }; d.moved = true;
    syncActions(); renderScaffoldsSelection(); drawAll();
  });
  cv.tracks.addEventListener('pointerup', e => {
    const d = S.trackDrag; S.trackDrag = null;
    if (d && !d.moved) {
      const r = cv.tracks.getBoundingClientRect(), p = Math.floor(binAt(e.clientX - r.left));
      if (p >= 0 && p < S.ds.n) { const s = S.geo.list[S.geo.scaf[p]]; S.sel = { a: s.a, b: s.b }; syncActions(); renderScaffoldsSelection(); drawAll(); }
    }
    updateFoldSoon();
  });
  cv.tracks.addEventListener('wheel', e => { if (!S.ds) return; e.preventDefault(); const r = cv.tracks.getBoundingClientRect(); zoomAt(e.clientX - r.left, cv.map.clientHeight / 2, Math.exp(-e.deltaY * 0.0018)); }, { passive: false });

  /* ───────────── scaffold list ───────────── */
  function scafBar(s) {
    const ds = S.ds;
    return P.runs(ds, S.L, s.a, s.b).map(r => `<i class="${r.rev ? 'rev' : ''}" style="flex:${r.end - r.start};background:${rgbCss(contigColor(ds.binContig[S.L.codes[r.a] >> 1]))}"></i>`).join('');
  }
  function renderScaffolds() {
    const list = S.geo.list, placed = list.filter(s => s.placed), loose = list.filter(s => !s.placed), cap = 400;
    $('#scaf-count').textContent = `${placed.length} placed${loose.length ? `, ${loose.length} unplaced` : ''}`;
    const row = s => `<li class="scaf" data-a="${s.a}" data-b="${s.b}" tabindex="0">
      <span class="scaf-name">${esc(s.name)}</span><span class="scaf-len">${P.fmtBp(s.len)}</span>
      <span class="scaf-bar">${scafBar(s)}</span>
      <span class="scaf-tools">
        <button type="button" data-do="flip" title="Reverse this scaffold" aria-label="Reverse ${esc(s.name)}"><svg><use href="#i-flip"/></svg></button>
        <button type="button" data-do="zoom" title="Zoom to this scaffold" aria-label="Zoom to ${esc(s.name)}"><svg><use href="#i-zoom"/></svg></button>
        <button type="button" data-do="place" title="${s.placed ? 'Take out of the assembly' : 'Add to the assembly'}" aria-label="${s.placed ? 'Unplace' : 'Place'} ${esc(s.name)}"><svg><use href="#i-unplace"/></svg></button>
      </span></li>`;
    let html = placed.slice(0, cap).map(row).join('');
    if (placed.length > cap) html += `<li class="sep">${placed.length - cap} more scaffolds are on the map</li>`;
    html += `<li class="sep" data-sep="1"><span>Unplaced</span><span>${loose.length ? P.fmtBp(S.stats.unplacedBp) : 'drop here to unplace'}</span></li>`;
    html += loose.slice(0, cap).map(row).join('');
    $('#scaf-list').innerHTML = html;
    renderScaffoldsSelection();
  }
  function renderScaffoldsSelection() {
    for (const li of $$('.scaf')) li.classList.toggle('on', !!S.sel && +li.dataset.a < S.sel.b && +li.dataset.b > S.sel.a);
  }
  (() => {
    const list = $('#scaf-list');
    let drag = null;
    list.addEventListener('pointerdown', e => {
      const li = e.target.closest('.scaf');
      if (!li || e.target.closest('button') || e.button !== 0) return;
      drag = { li, y: e.clientY, a: +li.dataset.a, b: +li.dataset.b, moved: false };
    });
    list.addEventListener('pointermove', e => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientY - drag.y) > 5) { drag.moved = true; list.setPointerCapture(e.pointerId); }
      if (!drag.moved) return;
      $$('.drop-before').forEach(x => x.classList.remove('drop-before'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.scaf, .sep[data-sep]');
      if (over && over !== drag.li) over.classList.add('drop-before');
    });
    list.addEventListener('pointerup', e => {
      if (!drag) return;
      const d = drag; drag = null;
      const target = $('.drop-before');
      $$('.drop-before').forEach(x => x.classList.remove('drop-before'));
      if (!d.moved) { S.sel = { a: d.a, b: d.b }; syncActions(); renderScaffoldsSelection(); drawAll(); updateFoldSoon(); return; }
      if (!target) return;
      const name = S.geo.list[S.geo.scaf[d.a]].name, len = d.b - d.a;
      if (target.dataset.sep) { if (d.a < S.L.debris) commit(P.ops.unplace(S.L, d.a, d.b), `Unplace ${name}`, { a: S.ds.n - len, b: S.ds.n }); return; }
      const t = +target.dataset.a;
      if (t === d.b) return;
      commit(P.ops.move(S.L, d.a, d.b, t), `Move ${name} before ${S.geo.list[S.geo.scaf[t]].name}`, { a: t <= d.a ? t : t - len, b: (t <= d.a ? t : t - len) + len });
    });
    list.addEventListener('click', e => {
      const btn = e.target.closest('button[data-do]'); if (!btn) return;
      const li = btn.closest('.scaf'), a = +li.dataset.a, b = +li.dataset.b, s = S.geo.list[S.geo.scaf[a]];
      if (btn.dataset.do === 'flip') commit(P.ops.invert(S.L, a, b), `Reverse ${s.name}`, { a, b });
      if (btn.dataset.do === 'zoom') { S.sel = { a, b }; zoomTo(a, b); syncActions(); renderScaffoldsSelection(); }
      if (btn.dataset.do === 'place') { S.sel = { a, b }; actions.unplace(); }
    });
    list.addEventListener('dblclick', e => { const li = e.target.closest('.scaf'); if (li) zoomTo(+li.dataset.a, +li.dataset.b); });
    list.addEventListener('keydown', e => { const li = e.target.closest('.scaf'); if (li && e.key === 'Enter') { S.sel = { a: +li.dataset.a, b: +li.dataset.b }; syncActions(); renderScaffoldsSelection(); zoomTo(S.sel.a, S.sel.b); } });
  })();

  /* ───────────── hints ───────────── */
  const ICON = { cut: 'i-cut', join: 'i-join', invert: 'i-invert', swap: 'i-move', insert: 'i-move' };
  function scheduleHints() {
    const job = ++S.hintJob, gen = S.scorer.suggest(S.L);
    S.hintsDone = false;
    $('#hint-status').textContent = 'Scanning the layout for edits that raise the likelihood…';
    const tick = () => {
      if (job !== S.hintJob) return;
      const t0 = performance.now();
      let r;
      do r = gen.next(); while (!r.done && performance.now() - t0 < 14);
      if (!r.done) { setTimeout(tick, 0); return; }
      S.hints = r.value.hints; S.hintsDone = true;
      renderHints();
      if (S.auto) setTimeout(autoStep, 160);
    };
    setTimeout(tick, 40);
  }
  function renderHints() {
    const h = S.hints, top = h[0] ? h[0].delta : 1;
    $('#hint-status').textContent = h.length
      ? `${h.length} edit${h.length > 1 ? 's' : ''} would raise the likelihood. Hover one to see where, apply it to try it; undo is always one step away.`
      : 'No single edit tested here raises the likelihood. Look for remaining weak junctions on the map, or refit the decay model.';
    $('#hints').innerHTML = h.map((x, i) => `<li class="hint" data-i="${i}">
      <span class="hint-kind"><svg><use href="#${ICON[x.type]}"/></svg></span>
      <span class="hint-label">${esc(x.label)}</span>
      <button class="btn small ghost" type="button" data-apply="${i}">Apply</button>
      <span class="hint-gain"><i style="width:${Math.max(4, 90 * x.delta / top)}px"></i>${signed(x.delta)}</span></li>`).join('') || '';
    $('#hint-best').disabled = !h.length;
    $('#hint-run').disabled = !h.length && !S.auto;
  }
  $('#hints').addEventListener('pointerover', e => { const li = e.target.closest('.hint'); const f = li ? S.hints[+li.dataset.i].focus : null; if (f !== S.preview) { S.preview = f; drawAll(); } });
  $('#hints').addEventListener('pointerleave', () => { S.preview = null; drawAll(); });
  $('#hints').addEventListener('click', e => {
    const b = e.target.closest('[data-apply]'), li = e.target.closest('.hint');
    if (b) { const h = S.hints[+b.dataset.apply]; S.preview = null; commit(h.layout, h.label, { a: h.focus[0], b: Math.min(S.ds.n, h.focus[1]) }); return; }
    if (li) { const f = S.hints[+li.dataset.i].focus; zoomTo(Math.max(0, f[0] - 8), Math.min(S.ds.n, f[1] + 8)); }
  });
  $('#hint-best').addEventListener('click', applyBest);
  function applyBest() {
    if (!S.hintsDone) { toast('Still scanning for hints.'); return; }
    const h = S.hints[0]; if (!h) { toast('No hint raises the likelihood right now.'); return; }
    commit(h.layout, h.label);
  }
  function autoStep() {
    if (!S.auto) return;
    if (!S.hints.length) { stopAuto(`Done: no further single edit raises the likelihood.`); return; }
    commit(S.hints[0].layout, 'Auto: ' + S.hints[0].label);
  }
  function stopAuto(msg) {
    S.auto = false;
    $('#hint-run').innerHTML = '<svg><use href="#i-play"/></svg><span>Apply until none help</span>';
    if (msg) toast(msg);
    renderHints();
  }
  $('#hint-run').addEventListener('click', () => {
    if (S.auto) { stopAuto(); return; }
    S.auto = true;
    $('#hint-run').disabled = false;
    $('#hint-run').innerHTML = '<svg><use href="#i-stop"/></svg><span>Stop</span>';
    if (S.hintsDone) autoStep();
  });

  /* ───────────── analysis tabs ───────────── */
  $$('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    $$('.tabs [role=tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $$('.tab').forEach(x => { x.hidden = x.id !== 'tab-' + S.tab; });
    renderTab(true);
  }));
  let tabTimer = 0;
  function renderTab(now) {
    clearTimeout(tabTimer);
    tabTimer = setTimeout(() => {
      if (S.tab === 'decay') drawDecay();
      if (S.tab === 'links') drawLinks();
      if (S.tab === 'dots') drawDots();
      if (S.tab === 'history') drawSpark();
      if (S.tab === 'fold') updateFold();
    }, now ? 0 : 180);
  }
  let foldTimer = 0;
  const updateFoldSoon = () => { if (S.tab === 'fold') { clearTimeout(foldTimer); foldTimer = setTimeout(updateFold, 220); } };

  function axisCanvas(c) {
    const r = fitCanvas(c);
    r.ctx.clearRect(0, 0, r.w, r.h);
    r.ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    return r;
  }
  function drawDecay() {
    const c = $('#decay'), { ctx, w, h } = axisCanvas(c), m = S.scorer.model, now = P.distanceProfile(S.ds, S.L), then = S.profile0;
    const pts = [...now.points, ...then.points].filter(q => q.p > 0);
    if (!pts.length) return;
    const L = { l: 44, r: 10, t: 10, b: 30 }, sx0 = Math.log10(Math.min(...pts.map(q => q.s))), sx1 = Math.log10(Math.max(...pts.map(q => q.s)));
    const py0 = Math.log10(Math.min(m.pT, ...pts.map(q => q.p)) * 0.7), py1 = Math.log10(Math.max(...pts.map(q => q.p)) * 1.4);
    const X = s => L.l + (Math.log10(s) - sx0) / (sx1 - sx0 || 1) * (w - L.l - L.r), Y = p => h - L.b - (Math.log10(p) - py0) / (py1 - py0) * (h - L.t - L.b);
    ctx.strokeStyle = T.line; ctx.fillStyle = T.muted; ctx.lineWidth = 1; ctx.textAlign = 'center';
    for (let e = Math.ceil(sx0); e <= sx1; e++) { const x = X(10 ** e); ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, h - L.b); ctx.stroke(); ctx.fillText(P.fmtBp(10 ** e), x, h - L.b + 14); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let e = Math.ceil(py0); e <= py1; e++) { const y = Y(10 ** e); ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(w - L.r, y); ctx.stroke(); ctx.fillText(`10${String(e).replace('-', '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d])}`, L.l - 6, y); }
    ctx.textAlign = 'center'; ctx.fillText('genomic distance', (L.l + w) / 2, h - 6);
    ctx.save(); ctx.translate(11, (L.t + h - L.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('contacts per bias pair', 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(L.l, L.t, w - L.l - L.r, h - L.t - L.b); ctx.clip();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = T.signal; ctx.beginPath(); ctx.moveTo(L.l, Y(m.pT)); ctx.lineTo(w, Y(m.pT)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = T.muted; ctx.lineWidth = 1.2;
    for (const q of then.points) if (q.p > 0) { ctx.beginPath(); ctx.arc(X(q.s), Y(q.p), 3, 0, 7); ctx.stroke(); }
    ctx.fillStyle = T.accent;
    for (const q of now.points) if (q.p > 0) { ctx.beginPath(); ctx.arc(X(q.s), Y(q.p), 3, 0, 7); ctx.fill(); }
    ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 160; i++) { const s = 10 ** (sx0 + (sx1 - sx0) * i / 160), x = X(s), y = Y(m.P(s)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke(); ctx.restore();
    $('#decay-lede').textContent = `Contacts fall with distance roughly as s to the power of −${m.alpha.toFixed(2)}. The score uses the model curve, fitted on the starting layout${S.refitted ? ' and refitted since' : ''}; points from a correct layout sit close to it.`;
    $('#decay-legend').innerHTML = `<span><span class="key fwd"></span>&nbsp;Current layout</span><span><span class="key" style="border:1.5px solid ${T.muted}"></span>&nbsp;Starting layout</span><span><span class="key line" style="background:${T.ink}"></span>&nbsp;Model</span><span><span class="key line" style="background:${T.signal}"></span>&nbsp;Between scaffolds</span>`;
  }
  $('#refit').addEventListener('click', () => {
    busy('Refitting the decay model…', () => {
      const model = P.fitModel(S.ds, S.L);
      S.scorer = new P.Scorer(S.ds, model); S.refitted = true;
      S.startScore = S.scorer.score(S.hist[0].L);
      for (const e of S.hist) e.score = S.scorer.score(e.L);
      refresh({ repaint: $('#mode').value === 'oe' });
      toast(`Refitted: decay exponent ${model.alpha.toFixed(2)}. All scores were recomputed with the new model.`);
    });
  });

  function drawLinks() {
    const c = $('#links'), { ctx, w, h } = axisCanvas(c), ds = S.ds, L = S.L, n = ds.n, geo = S.geo;
    const all = geo.list, keep = all.map((s, i) => i).sort((x, y) => all[y].len - all[x].len).slice(0, 80).sort((x, y) => x - y), idx = new Int32Array(all.length).fill(-1);
    keep.forEach((s, k) => { idx[s] = k; });
    const m = keep.length, link = new Float64Array(m * m), wpos = new Float64Array(m * m), mass = new Float64Array(m), { obs, bias } = ds;
    for (let x = 0; x < n; x++) mass[idx[geo.scaf[x]]] += idx[geo.scaf[x]] >= 0 ? bias[L.codes[x] >> 1] : 0;
    for (let x = 0; x < n; x++) {
      const u = idx[geo.scaf[x]]; if (u < 0) continue;
      const row = (L.codes[x] >> 1) * n, frac = (geo.off[x] + ds.binLen[L.codes[x] >> 1] / 2) / all[keep[u]].len;
      for (let y = 0; y < n; y++) {
        const v = idx[geo.scaf[y]]; if (v < 0 || v === u) continue;
        const c2 = obs[row + (L.codes[y] >> 1)];
        link[u * m + v] += c2; wpos[u * m + v] += c2 * frac;
      }
    }
    const pT = S.scorer.model.pT, ribbons = [];
    for (let u = 0; u < m; u++) for (let v = u + 1; v < m; v++) {
      const e = link[u * m + v] / (pT * mass[u] * mass[v] || Infinity);
      if (e > 1.6 && link[u * m + v] >= 10) ribbons.push({ u, v, e, fu: wpos[u * m + v] / link[u * m + v], fv: wpos[v * m + u] / link[v * m + u] });
    }
    ribbons.sort((a, b) => b.e - a.e); ribbons.length = Math.min(ribbons.length, 70);
    const total = keep.reduce((t, s) => t + all[s].len, 0), gap = Math.min(0.04, 1.2 / m), R = Math.min(w, h) / 2 - 34, cx = w / 2, cy = h / 2;
    const arcs = []; let ang = -Math.PI / 2;
    for (const s of keep) { const sweep = (2 * Math.PI - gap * m) * all[s].len / total; arcs.push({ a0: ang, a1: ang + sweep, s: all[s] }); ang += sweep + gap; }
    const at = (u, f) => arcs[u].a0 + (arcs[u].a1 - arcs[u].a0) * clamp(f, 0, 1);
    const emax = ribbons[0] ? Math.log(ribbons[0].e) : 1;
    S.linkHit = [];
    for (const r of ribbons.slice().reverse()) {
      const t = Math.log(r.e) / emax, a = at(r.u, r.fu), b = at(r.v, r.fv), col = scafColor(keep[r.u], 0.3);
      const half = 0.008 + 0.03 * t;
      ctx.beginPath();
      ctx.moveTo(cx + R * Math.cos(a - half), cy + R * Math.sin(a - half));
      ctx.quadraticCurveTo(cx, cy, cx + R * Math.cos(b + half), cy + R * Math.sin(b + half));
      ctx.arc(cx, cy, R, b + half, b - half, true);
      ctx.quadraticCurveTo(cx, cy, cx + R * Math.cos(a + half), cy + R * Math.sin(a + half));
      ctx.closePath();
      ctx.fillStyle = rgbCss(col); ctx.globalAlpha = 0.18 + 0.55 * t; ctx.fill(); ctx.globalAlpha = 1;
      S.linkHit.push({ A: all[keep[r.u]], B: all[keep[r.v]], ax: cx + R * Math.cos(a), ay: cy + R * Math.sin(a), bx: cx + R * Math.cos(b), by: cy + R * Math.sin(b) });
    }
    arcs.forEach((arc, u) => {
      ctx.beginPath(); ctx.arc(cx, cy, R + 7, arc.a0, arc.a1); ctx.lineWidth = 10;
      const on = S.sel && S.sel.a < arc.s.b && S.sel.b > arc.s.a;
      ctx.strokeStyle = on ? T.accent : arc.s.placed ? rgbCss(scafColor(keep[u], 0.3)) : T.line; ctx.stroke();
      if (arc.a1 - arc.a0 > 0.16) {
        const mid = (arc.a0 + arc.a1) / 2;
        ctx.save(); ctx.translate(cx + (R + 20) * Math.cos(mid), cy + (R + 20) * Math.sin(mid));
        ctx.rotate(mid + Math.PI / 2 + (Math.sin(mid) > 0 ? Math.PI : 0));
        ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(arc.s.name.replace('scaffold_', 's').replace('unplaced_', 'u'), 0, 0); ctx.restore();
      }
    });
    if (!ribbons.length) { ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.fillText('No scaffold pairs share more contacts than background.', cx, cy); }
  }
  $('#links').addEventListener('click', e => {
    if (!S.linkHit) return;
    const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 30;
    // ribbons are quadratic curves through the centre: test both ends and the curve midpoint
    const cx = r.width / 2, cy = r.height / 2;
    for (const hit of S.linkHit) for (const [hx, hy] of [[hit.ax, hit.ay], [hit.bx, hit.by], [(hit.ax + hit.bx) / 4 + cx / 2, (hit.ay + hit.by) / 4 + cy / 2]]) {
      const d = Math.hypot(hx - x, hy - y); if (d < bd) { bd = d; best = hit; }
    }
    if (!best) return;
    zoomTo(best.A.a, best.A.b, best.B.a, best.B.b);
    toast(`Showing contacts between ${best.A.name} (across) and ${best.B.name} (down).`);
  });

  function drawDots() {
    const c = $('#dots'), { ctx, w, h } = axisCanvas(c), ds = S.ds, L = S.L, n = ds.n, truth = ds.truth && $('#dots-truth').checked;
    $('#dots-truth-row').hidden = !ds.truth;
    const pad = 28, W = w - pad - 8, H = h - pad - 8, cur = new Float64Array(n + 1);
    for (let p = 0; p < n; p++) cur[p + 1] = cur[p] + ds.binLen[L.codes[p] >> 1];
    const src = new Float64Array(n);
    if (truth) { const order = Array.from({ length: n }, (_, b) => b).sort((a, b) => ds.truth.pos[a] - ds.truth.pos[b]); let acc = 0; for (const b of order) { src[b] = acc; acc += ds.binLen[b]; } }
    else { let acc = 0; for (let b = 0; b < n; b++) { src[b] = acc; acc += ds.binLen[b]; } }
    const G = ds.genome, X = v => pad + v / G * W, Y = v => 4 + v / G * H;
    ctx.fillStyle = T.bg; ctx.fillRect(pad, 4, W, H);
    if (L.debris < n) { ctx.fillStyle = T.sunken; ctx.fillRect(X(cur[L.debris]), 4, W - X(cur[L.debris]) + pad, H); }
    ctx.strokeStyle = T.line; ctx.lineWidth = 1; ctx.beginPath();
    for (const s of S.geo.list) { ctx.moveTo(Math.round(X(cur[s.a])) + 0.5, 4); ctx.lineTo(Math.round(X(cur[s.a])) + 0.5, 4 + H); }
    if (truth) { let acc = 0; for (let k = 0; k < ds.truth.chroms; k++) { ctx.moveTo(pad, Y(acc) + 0.5); ctx.lineTo(pad + W, Y(acc) + 0.5); acc += ds.truth.seqs[k].length; } }
    else for (const ctg of ds.contigs) { const yy = Math.round(Y(src[ctg.first])) + 0.5; ctx.moveTo(pad, yy); ctx.lineTo(pad + W, yy); }
    ctx.stroke();
    const size = Math.max(1.5, Math.min(4, W / n * 1.6));
    for (let p = 0; p < n; p++) {
      const code = L.codes[p], b = code >> 1, rev = truth ? (code & 1) ^ ds.truth.rev[b] : code & 1;
      ctx.fillStyle = rev ? T.signal : T.accent;
      ctx.fillRect(X((cur[p] + cur[p + 1]) / 2) - size / 2, Y(src[b] + ds.binLen[b] / 2) - size / 2, size, size);
    }
    ctx.fillStyle = T.muted; ctx.textAlign = 'center';
    ctx.fillText('current assembly', pad + W / 2, h - 6);
    ctx.save(); ctx.translate(11, 4 + H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(truth ? 'simulated truth' : 'input contigs', 0, 0); ctx.restore();
    $('#dots-lede').textContent = truth
      ? 'Each bin in the current assembly (across) against its place in the simulated genome (down). A correct assembly runs as one unbroken diagonal per chromosome, top left to bottom right; a whole chromosome drawn in red is reversed end to end, which is still correct.'
      : 'Each bin in the current assembly (across) against its place in the input (down). Blocks off the diagonal are pieces you moved; red ones are reversed.';
  }
  $('#dots-truth').addEventListener('change', drawDots);
  $('#dots').addEventListener('click', e => {
    const r = e.target.getBoundingClientRect(), f = (e.clientX - r.left - 28) / (r.width - 36);
    if (f < 0 || f > 1) return;
    let acc = 0, target = f * S.ds.genome, p = 0;
    while (p < S.ds.n - 1 && acc + S.ds.binLen[S.L.codes[p] >> 1] < target) acc += S.ds.binLen[S.L.codes[p++] >> 1];
    const span = Math.max(20, S.ds.n / 10);
    zoomTo(Math.max(0, p - span / 2), Math.min(S.ds.n, p + span / 2));
  });

  function drawSpark() {
    const c = $('#spark'), { ctx, w, h } = axisCanvas(c), vals = S.hist.map(e => e.score - S.startScore);
    const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals), X = i => 8 + i / Math.max(1, vals.length - 1) * (w - 16), Y = v => h - 16 - (v - lo) / (hi - lo) * (h - 30);
    ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(8, Y(0)); ctx.lineTo(w - 8, Y(0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0), Y(lo));
    vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(vals.length - 1), Y(lo)); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, T.dark ? 'rgba(69,192,138,.35)' : 'rgba(30,133,86,.25)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = T.good; ctx.lineWidth = 1.8; ctx.beginPath();
    vals.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.stroke();
    ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(X(S.hi), Y(vals[S.hi]), 4.5, 0, 7); ctx.fill();
    ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.fillText(`best ${signed(Math.max(...vals))}`, w - 8, 11);
    ctx.textAlign = 'left'; ctx.fillText('Δ log-likelihood over the edits', 8, 11);
  }
  function renderHistory() {
    $('#history').innerHTML = S.hist.map((e, i) => {
      const d = i ? e.score - S.hist[i - 1].score : 0;
      return `<li data-i="${i}" class="${i === S.hi ? 'now' : i > S.hi ? 'future' : ''}"><span>${esc(e.label)}</span><span class="gain">${i ? signed(d) : ''}</span></li>`;
    }).reverse().join('');
    if (S.tab === 'history') drawSpark();
  }
  $('#history').addEventListener('click', e => { const li = e.target.closest('li'); if (li) jump(+li.dataset.i); });
  $('#spark').addEventListener('click', e => { const r = e.target.getBoundingClientRect(); jump(Math.round((e.clientX - r.left - 8) / (r.width - 16) * (S.hist.length - 1))); });

  /* ───────────── 3D fold ───────────── */
  async function updateFold() {
    if (S.tab !== 'fold' || !S.ds) return;
    const el = $('#fold'), msg = $('#fold-msg');
    let THREE;
    try { THREE = await F.loadThree(); } catch (err) { msg.hidden = false; msg.textContent = err.message; return; }
    if (!S.viewer) {
      try { S.viewer = new F.Viewer(el, THREE); } catch (err) { msg.hidden = false; msg.textContent = 'This browser cannot draw 3D graphics (WebGL is off or unavailable).'; return; }
    }
    msg.hidden = true;
    const ds = S.ds, L = S.L, geo = S.geo, scope = $('#fold-scope').value;
    let a = 0, b = ds.n;
    if (scope === 'scaffold') { const s = geo.list[geo.scaf[S.sel ? S.sel.a : geo.list.reduce((best, x, i) => x.len > geo.list[best].len ? i : best, 0)]] || geo.list[0]; ({ a, b } = s); }
    const list = F.beads(ds, L, a, b, scope === 'all' ? 320 : 260), xyz = F.embed(ds, L, list), mode = $('#fold-color').value;
    const covLut = lut(MAPS.viridis), lb = list.map(bd => { let s = 0; for (let p = bd.a; p < bd.b; p++) s += S.coverage[L.codes[p] >> 1]; return s / (bd.b - bd.a); });
    const cmax = [...lb].sort((x, y) => x - y)[Math.floor(lb.length * 0.98)] || 1, acc = parseColor(T.accent).map(v => v / 255);
    const chains = [];
    list.forEach((bd, u) => {
      if (!u || bd.chain !== list[u - 1].chain) chains.push({ beads: [] });
      chains[chains.length - 1].beads.push(u);
    });
    S.viewer.show(chains.map(ch => {
      const xs = new Float32Array(ch.beads.length * 3), colors = ch.beads.map((u, k) => {
        xs.set(xyz.subarray(u * 3, u * 3 + 3), k * 3);
        const bd = list[u];
        if (S.sel && bd.a < S.sel.b && bd.b > S.sel.a) return acc;
        if (mode === 'origin') return contigColor(ds.binContig[L.codes[bd.a] >> 1]);
        if (mode === 'cover') { const v = covLut[Math.min(254, Math.round(254 * lb[u] / cmax))]; return [v & 255, v >> 8 & 255, v >> 16 & 255].map(q => q / 255); }
        return scafColor(geo.scaf[bd.a], ch.beads.length > 1 ? k / (ch.beads.length - 1) : 0.5);
      });
      return { xyz: xs, colors };
    }), scope === 'all' ? 0.2 : 0.28);
  }
  $('#fold-scope').addEventListener('change', updateFold);
  $('#fold-color').addEventListener('change', updateFold);

  /* ───────────── view controls ───────────── */
  for (const id of ['#mode', '#scale', '#contrast', '#cmap']) $(id).addEventListener(id === '#contrast' ? 'input' : 'change', () => {
    if (!S.ds) return;
    computeLevels(); paintImage(); drawAll();
  });
  $('#fit').addEventListener('click', () => S.ds && fitView());
  const themeWatch = () => { refreshTheme(); if (S.ds) { paintImage(); refresh({ repaint: false }); } };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeWatch);
  new MutationObserver(themeWatch).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new ResizeObserver(() => { if (S.ds) { if (S.fitted) fitView(); else drawAll(); if (['links', 'dots', 'decay', 'history'].includes(S.tab)) renderTab(); } }).observe($('#stage'));

  /* ───────────── buttons and keys ───────────── */
  $('#undo').addEventListener('click', () => jump(S.hi - 1));
  $('#redo').addEventListener('click', () => jump(S.hi + 1));
  $$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#act-invert').addEventListener('click', actions.invert);
  $('#act-move').addEventListener('click', actions.move);
  $('#act-excise').addEventListener('click', actions.excise);
  $('#act-unplace').addEventListener('click', actions.unplace);
  $('#help').addEventListener('click', () => $('#help-dialog').showModal());
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea, dialog') || !S.ds) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); jump(S.hi + (e.shiftKey ? 1 : -1)); return; }
    if (mod && k === 'y') { e.preventDefault(); jump(S.hi + 1); return; }
    if (mod) return;
    if (k === ' ') { S.space = true; e.preventDefault(); return; }
    const map = { i: actions.invert, m: actions.move, e: actions.excise, delete: actions.unplace, backspace: actions.unplace, h: applyBest,
      v: () => setTool('select'), k: () => setTool('cut'), j: () => setTool('join'), 0: fitView, '?': () => $('#help-dialog').showModal(),
      z: () => S.sel && zoomTo(S.sel.a, S.sel.b),
      escape: () => { if (S.moving) { S.moving = false; } else if (S.tool !== 'select') setTool('select'); else S.sel = null; syncActions(); renderScaffoldsSelection(); drawAll(); } };
    if (map[k]) { e.preventDefault(); map[k](); }
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') S.space = false; });

  /* ───────────── feedback ───────────── */
  function toast(text, opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (opts.bad ? ' bad' : '');
    el.innerHTML = `<span>${esc(text)}</span>`;
    if (opts.action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = opts.action; b.onclick = () => { opts.onAction(); el.remove(); }; el.appendChild(b); }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), opts.ms || (opts.action ? 9000 : 3800));
  }
  function busy(text, fn) {
    $('#busy-text').textContent = text; $('#busy').hidden = false;
    setTimeout(async () => {
      try { await fn(); } catch (err) { console.error(err); toast(err.message || String(err), { bad: true, ms: 8000 }); } finally { $('#busy').hidden = true; }
    }, 30);
  }

  /* ───────────── dataset lifecycle ───────────── */
  const fingerprint = ds => `percival:${ds.n}:${Math.round(ds.total)}:${ds.contigs.length}`;
  let saveTimer = 0;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(fingerprint(S.ds), JSON.stringify({ ...P.sessionOf(S.ds, S.L, []), label: S.label, at: Date.now() })); } catch (_) { /* storage is optional */ }
    }, 800);
  }
  function setDataset(ds, label, layout, logLabel) {
    S.ds = ds; S.label = label; S.sel = null; S.moving = false; S.refitted = false; S.auto = false;
    const start = layout || P.initialLayout(ds);
    S.L = start;
    S.scorer = new P.Scorer(ds, P.fitModel(ds, start));
    S.startScore = S.scorer.score(start);
    S.profile0 = P.distanceProfile(ds, start);
    S.hist = [{ L: start, label: logLabel || 'Start', score: S.startScore }]; S.hi = 0;
    S.coverage = new Float64Array(ds.n);
    for (let i = 0; i < ds.n; i++) { let s = 0; for (let j = 0; j < ds.n; j++) if (j !== i) s += ds.counts[i * ds.n + j]; S.coverage[i] = s; }
    S.coverTop = [...S.coverage].sort((a, b) => a - b)[Math.floor(ds.n * 0.98)] || 1;
    $('#dataset-name').textContent = label;
    $('#dataset-name').title = `${label}: ${fmtInt(ds.n)} bins, ${fmtInt(ds.contigs.length)} contigs, ${P.fmtBp(ds.genome)}, ${fmtInt(ds.total)} contacts. Click to load other data.`;
    document.title = `${label} — Percival`;
    computeLevels();
    derive(); paintImage(); fitView(); refresh({ repaint: false });
    for (const note of ds.notes) toast(note, { ms: 9000 });
    try {
      const saved = JSON.parse(localStorage.getItem(fingerprint(ds)) || 'null');
      if (saved && !layout) {
        const L = P.layoutFromSession(ds, saved);
        if (!L.codes.every((c, p) => c === start.codes[p]) || !L.cuts.every((c, p) => c === start.cuts[p])) {
          toast(`You edited this map before (${new Date(saved.at).toLocaleString()}).`, { action: 'Resume', onAction: () => commit(L, 'Resume saved layout') });
        }
      }
    } catch (_) { /* nothing saved, or saved for a different map */ }
  }

  /* ───────────── loading ───────────── */
  const dlg = $('#load-dialog');
  $('#open-load').addEventListener('click', () => dlg.showModal());
  $('#dataset-name').addEventListener('click', () => dlg.showModal());
  $$('.demo').forEach(b => b.addEventListener('click', () => {
    dlg.close();
    busy('Simulating Hi-C contacts…', () => { const ds = P.makeDemo(b.dataset.demo); setDataset(ds, ds.label); });
  }));
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); stage([...e.dataTransfer.files]); });
  document.addEventListener('dragover', e => { if (!dlg.open && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dlg.showModal(); } });
  $('#files').addEventListener('change', e => { stage([...e.target.files]); e.target.value = ''; });
  $('#url-add').addEventListener('click', async () => {
    const url = $('#url').value.trim();
    if (!url) return;
    const item = { name: decodeURIComponent(url.split('?')[0].split('/').pop() || 'download'), size: 0, status: 'reading' };
    S.staged.push(item); renderStaged();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}.`);
      const blob = await res.blob();
      Object.assign(item, { file: blob, size: blob.size });
      await ingestItem(item);
      $('#url').value = '';
    } catch (err) {
      Object.assign(item, { status: 'error', error: err.message === 'Failed to fetch' ? 'The file could not be downloaded here (blocked by the network or by the server’s sharing rules). Download it and add it as a file instead.' : err.message });
      renderStaged();
    }
  });
  async function ingestItem(item) {
    item.status = 'reading'; renderStaged();
    try {
      item.binSize = +$('#bin-size').value;
      item.part = await P.ingest(item.name, item.file, { binSize: item.binSize });
      item.status = 'ok';
    } catch (err) { item.status = 'error'; item.error = err.message; }
    renderStaged();
  }
  function stage(files) {
    for (const f of files) { const item = { name: f.name, size: f.size, file: f, status: 'reading' }; S.staged.push(item); ingestItem(item); }
    if (!dlg.open) dlg.showModal();
  }
  const KIND = { fasta: 'sequences (FASTA)', dense: 'contacts, dense matrix', coo: 'contacts, sparse triplets', bg2: 'contacts, bedgraph2', pairs: 'contacts, pairs', bins: 'bin table', frags: 'fragment list', sizes: 'sequence lengths', agp: 'layout (AGP)', session: 'Percival session' };
  function renderStaged() {
    $('#staged').innerHTML = S.staged.map((it, i) => `<li><span>${esc(it.name)} <span class="kind">${it.size ? P.fmtBp(it.size).replace('bp', 'B').replace(/([kMG])b/, '$1B') : ''}</span></span>
      <span class="kind">${it.status === 'reading' ? 'reading…' : it.status === 'ok' ? KIND[it.part.kind] : 'not readable'}</span>
      <button type="button" data-drop="${i}" aria-label="Remove ${esc(it.name)}"><svg><use href="#i-close"/></svg></button>
      ${it.status === 'error' ? `<span class="bad">${esc(it.error)}</span>` : ''}</li>`).join('');
    const parts = S.staged.filter(x => x.status === 'ok').map(x => x.part), contacts = parts.filter(p => p.type === 'contacts').length;
    const layoutOnly = !contacts && S.ds && parts.some(p => p.type === 'agp' || p.type === 'session');
    $('#load-go').disabled = !(contacts === 1 || layoutOnly) || S.staged.some(x => x.status === 'reading');
    $('#load-go').textContent = layoutOnly ? 'Apply layout to the open map' : 'Open';
    $('#load-error').hidden = contacts <= 1;
    $('#load-error').textContent = contacts > 1 ? 'Add only one contact map at a time; remove the others.' : '';
  }
  $('#staged').addEventListener('click', e => { const b = e.target.closest('[data-drop]'); if (b) { S.staged.splice(+b.dataset.drop, 1); renderStaged(); } });
  $('#load-go').addEventListener('click', async () => {
    const binSize = +$('#bin-size').value, maxBins = +$('#max-bins').value;
    for (const it of S.staged) if (it.status === 'ok' && it.part.kind === 'pairs' && it.binSize !== binSize) await ingestItem(it);
    const parts = {};
    for (const it of S.staged) if (it.status === 'ok') parts[it.part.type] = it.part;
    dlg.close();
    busy(parts.contacts ? 'Building and balancing the contact map…' : 'Applying the layout…', () => {
      if (parts.contacts) {
        const ds = P.build(parts, { binSize, maxBins }), name = parts.contacts.name.replace(/\.(gz|bgz)$/, '');
        const layout = parts.agp ? P.layoutFromAgp(ds, parts.agp.rows) : parts.session ? P.layoutFromSession(ds, parts.session.session) : null;
        setDataset(ds, name, layout, layout ? `Start from ${(parts.agp || parts.session).name}` : 'Start');
      } else {
        const L = parts.agp ? P.layoutFromAgp(S.ds, parts.agp.rows) : P.layoutFromSession(S.ds, parts.session.session);
        commit(L, `Apply ${(parts.agp || parts.session).name}`, null);
      }
      S.staged = []; renderStaged();
    });
  });

  /* ───────────── export ───────────── */
  async function save(filename, data, type = 'text/plain') {
    const blob = data instanceof Blob ? data : new Blob(Array.isArray(data) ? data : [data], { type });
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (_) { dl = null; }
    if (dl) {
      const name = /\.(txt|json|md|csv|png|svg|html|pdf|zip)$/i.test(filename) ? filename : filename + '.txt';
      try { await dl.save({ filename: name, data: blob }); toast(`Saved ${name}`); return; }
      catch (err) { if (err && err.code === 'declined') return; if (err && err.code !== 'unavailable') { toast(err.message || 'The file could not be saved.', { bad: true }); return; } }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const base = () => S.label.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'assembly';
  const EXPORTS = [
    ['agp', 'Scaffolds as AGP', 'AGP 2.1 with 100 bp gaps between pieces, for submission and downstream tools.', () => save(`${base()}.agp`, P.exporters.agp(S.ds, S.L))],
    ['fasta', 'Scaffold sequences', 'FASTA with reverse-complemented pieces and 100 N gaps.', () => save(`${base()}.scaffolds.fa`, P.exporters.fasta(S.ds, S.L)), () => !!S.ds.seqs],
    ['bed', 'Where pieces went', 'BED of input intervals, named by their new scaffold coordinates.', () => save(`${base()}.liftover.bed`, P.exporters.bed(S.ds, S.L))],
    ['frags', 'Bin layout', 'instaGRAAL-style info_frags.txt, one line per bin with orientation.', () => save(`${base()}.info_frags.txt`, P.exporters.infoFrags(S.ds, S.L))],
    ['bg2', 'Reordered contacts', 'Bedgraph2 contacts in the coordinates of the new scaffolds.', () => save(`${base()}.reordered.bg2`, P.exporters.bg2(S.ds, S.L))],
    ['matrix', 'Reordered matrix', 'Dense tab-separated matrix in the current order.', () => save(`${base()}.reordered.tsv`, P.exporters.matrix(S.ds, S.L))],
    ['session', 'Session', 'Layout and edit list, to resume later in Percival.', () => save(`${base()}.percival.json`, JSON.stringify({ ...P.sessionOf(S.ds, S.L, S.hist.slice(1, S.hi + 1).map(e => e.label)), label: S.label }))],
    ['png', 'Map image', 'The full contact map in the current order with scaffold outlines, as PNG.', exportPng]
  ];
  function exportPng() {
    const n = S.ds.n, f = Math.max(1, Math.ceil(1600 / n)), c = document.createElement('canvas');
    c.width = c.height = n * f;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false; ctx.drawImage(S.image, 0, 0, n * f, n * f);
    ctx.strokeStyle = T.dark ? 'rgba(229,235,241,.7)' : 'rgba(20,32,43,.6)'; ctx.lineWidth = Math.max(1, f / 2);
    for (const s of S.geo.list) ctx.strokeRect(s.a * f, s.a * f, (s.b - s.a) * f, (s.b - s.a) * f);
    c.toBlob(b => save(`${base()}.map.png`, b));
  }
  $('#open-export').addEventListener('click', () => {
    $('#exports').innerHTML = EXPORTS.map(([id, title, text, , ok]) => `<button class="export" type="button" data-x="${id}" ${ok && !ok() ? 'disabled title="Load a FASTA with the map to export sequences."' : ''}><strong>${title}</strong><span>${text}</span></button>`).join('');
    $('#export-dialog').showModal();
  });
  $('#exports').addEventListener('click', e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const x = EXPORTS.find(z => z[0] === b.dataset.x);
    $('#export-dialog').close();
    busy('Writing the file…', x[3]);
  });

  /* ───────────── start ───────────── */
  refreshTheme();
  busy('Simulating Hi-C contacts…', () => { const ds = P.makeDemo('curation'); setDataset(ds, ds.label); });
  Object.defineProperty(window, 'percival', { value: { state: S, actions, setDataset }, configurable: true });
})();
