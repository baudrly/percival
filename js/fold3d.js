/* Percival 3D: ShRec3D-style embedding (contacts → distances → shortest paths → classical MDS) and a Three.js viewer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fold3D = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

  /** Group positions [a,b) of layout L into at most maxBeads beads that never straddle a scaffold break. */
  function beads(ds, L, a, b, maxBeads) {
    const per = Math.max(1, Math.ceil((b - a) / maxBeads)), out = [];
    for (let p = a; p < b;) {
      let q = p + 1;
      while (q < b && q - p < per && !L.cuts[q]) q++;
      out.push({ a: p, b: q, chain: 0 });
      p = q;
    }
    let chain = 0;
    out.forEach((bd, k) => { if (k && L.cuts[bd.a]) chain++; bd.chain = chain; });
    return out;
  }

  /** Embed beads in 3D. Returns Float32Array xyz (length 3m). */
  function embed(ds, L, list) {
    const m = list.length, n = ds.n, { obs, bias } = ds, D = new Float32Array(m * m), B = new Float64Array(m), owner = new Int32Array(n).fill(-1);
    list.forEach((bd, u) => { for (let p = bd.a; p < bd.b; p++) { const bin = L.codes[p] >> 1; owner[bin] = u; B[u] += bias[bin]; } });
    const C = new Float64Array(m * m);
    for (let u = 0; u < m; u++) for (let p = list[u].a; p < list[u].b; p++) {
      const row = (L.codes[p] >> 1) * n;
      for (let j = 0; j < n; j++) { const v = owner[j]; if (v > u) C[u * m + v] += obs[row + j]; }
    }
    // wish distance d ∝ F^(-1/3), F the balanced contact frequency
    let hi = 0;
    for (let u = 0; u < m; u++) for (let v = u + 1; v < m; v++) {
      const f = C[u * m + v] / ((B[u] * B[v]) || Infinity), d = f > 0 ? Math.cbrt(1 / f) : Infinity;
      D[u * m + v] = D[v * m + u] = d;
      if (d < Infinity && d > hi) hi = d;
    }
    for (let k = 0; k < m * m; k++) if (D[k] === Infinity) D[k] = hi * 1.5;
    for (let u = 0; u < m; u++) D[u * m + u] = 0;
    // shortest paths (Floyd–Warshall)
    for (let k = 0; k < m; k++) {
      const rk = k * m;
      for (let i = 0; i < m; i++) {
        const ri = i * m, dik = D[ri + k];
        for (let j = 0; j < m; j++) { const via = dik + D[rk + j]; if (via < D[ri + j]) D[ri + j] = via; }
      }
    }
    // classical MDS: B = -½ J D² J, top three eigenvectors by power iteration with deflation
    const G = new Float64Array(m * m), rowMean = new Float64Array(m);
    let all = 0;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) { const d2 = D[i * m + j] ** 2; G[i * m + j] = d2; rowMean[i] += d2 / m; all += d2 / (m * m); }
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) G[i * m + j] = -0.5 * (G[i * m + j] - rowMean[i] - rowMean[j] + all);
    const xyz = new Float32Array(m * 3), v = new Float64Array(m), w = new Float64Array(m);
    let seed = 7;
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < m; i++) v[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
      let lambda = 0;
      for (let it = 0; it < 300; it++) {
        w.fill(0);
        for (let i = 0; i < m; i++) { const ri = i * m; let s = 0; for (let j = 0; j < m; j++) s += G[ri + j] * v[j]; w[i] = s; }
        let norm = 0, change = 0;
        for (let i = 0; i < m; i++) norm += w[i] * w[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < m; i++) { const x = w[i] / norm; change += Math.abs(x - v[i]); v[i] = x; }
        lambda = norm;
        if (change < 1e-7 * m) break;
      }
      const scale = Math.sqrt(Math.max(lambda, 0));
      for (let i = 0; i < m; i++) xyz[i * 3 + axis] = v[i] * scale;
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) G[i * m + j] -= lambda * v[i] * v[j];
    }
    // centre and fit in a radius of 10
    let r = 0;
    for (let ax = 0; ax < 3; ax++) { let c = 0; for (let i = 0; i < m; i++) c += xyz[i * 3 + ax] / m; for (let i = 0; i < m; i++) xyz[i * 3 + ax] -= c; }
    for (let i = 0; i < m; i++) r = Math.max(r, Math.hypot(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]));
    for (let k = 0; k < xyz.length; k++) xyz[k] *= 10 / (r || 1);
    return xyz;
  }

  let loading = null;
  const loadThree = () => loading || (loading = new Promise((ok, fail) => {
    if (globalThis.THREE) return ok(globalThis.THREE);
    const s = document.createElement('script');
    s.src = THREE_URL; s.async = true;
    s.onload = () => ok(globalThis.THREE);
    s.onerror = () => { loading = null; fail(new Error('The 3D library could not be downloaded. Check the connection and open this tab again.')); };
    document.head.appendChild(s);
  }));

  /** Viewer bound to a container element. */
  class Viewer {
    constructor(el, THREE) {
      Object.assign(this, { el, THREE, spin: true, drag: null, still: matchMedia('(prefers-reduced-motion: reduce)').matches });
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      el.appendChild(this.renderer.domElement);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
      this.camera.position.set(0, 0, 34);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.85));
      const key = new THREE.DirectionalLight(0xffffff, 0.75);
      key.position.set(8, 12, 16);
      this.scene.add(key);
      this.group = new THREE.Group();
      this.group.rotation.set(0.35, -0.5, 0);
      this.scene.add(this.group);
      const c = this.renderer.domElement;
      c.addEventListener('pointerdown', e => { this.drag = { x: e.clientX, y: e.clientY }; this.spin = false; c.setPointerCapture(e.pointerId); });
      c.addEventListener('pointermove', e => {
        if (!this.drag) return;
        this.group.rotation.y += (e.clientX - this.drag.x) * 0.008;
        this.group.rotation.x += (e.clientY - this.drag.y) * 0.008;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        this.draw();
      });
      const end = () => { this.drag = null; };
      c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', e => { e.preventDefault(); this.camera.position.z = Math.min(90, Math.max(8, this.camera.position.z * Math.exp(e.deltaY * 0.001))); this.draw(); }, { passive: false });
      c.addEventListener('dblclick', () => { this.spin = !this.spin; this.loop(); });
      new ResizeObserver(() => this.resize()).observe(el);
      this.resize();
    }
    resize() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.draw();
    }
    /** chains: [{xyz: Float32Array, colors: [[r,g,b]...]}] */
    show(chains, radius) {
      const T = this.THREE;
      for (const child of [...this.group.children]) { child.geometry.dispose(); child.material.dispose(); this.group.remove(child); }
      for (const ch of chains) {
        const m = ch.xyz.length / 3, pts = [];
        for (let i = 0; i < m; i++) pts.push(new T.Vector3(ch.xyz[i * 3], ch.xyz[i * 3 + 1], ch.xyz[i * 3 + 2]));
        if (m === 1) {
          const ball = new T.Mesh(new T.SphereGeometry(radius * 1.6, 16, 12), new T.MeshStandardMaterial({ color: new T.Color(...ch.colors[0]), roughness: 0.45 }));
          ball.position.copy(pts[0]); this.group.add(ball); continue;
        }
        const curve = new T.CatmullRomCurve3(pts, false, 'centripetal'), seg = Math.min(2400, m * 6), radial = 10;
        const geo = new T.TubeGeometry(curve, seg, radius, radial, false), col = new Float32Array((seg + 1) * (radial + 1) * 3);
        for (let i = 0; i <= seg; i++) {
          const t = (i / seg) * (m - 1), k = Math.min(m - 2, Math.floor(t)), f = t - k, c0 = ch.colors[k], c1 = ch.colors[k + 1];
          for (let r = 0; r <= radial; r++) for (let ax = 0; ax < 3; ax++) col[(i * (radial + 1) + r) * 3 + ax] = c0[ax] + (c1[ax] - c0[ax]) * f;
        }
        geo.setAttribute('color', new T.BufferAttribute(col, 3));
        this.group.add(new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05 })));
        for (const end of [0, m - 1]) {
          const cap = new T.Mesh(new T.SphereGeometry(radius * 1.02, 12, 10), new T.MeshStandardMaterial({ color: new T.Color(...ch.colors[end]), roughness: 0.42 }));
          cap.position.copy(pts[end]); this.group.add(cap);
        }
      }
      this.draw();
      this.loop();
    }
    loop() {
      if (this.raf || this.still || !this.spin) return;
      const step = () => {
        this.raf = 0;
        if (!this.spin || !this.el.isConnected || !this.el.offsetParent) return;
        this.group.rotation.y += 0.0035;
        this.draw();
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }
    draw() { this.renderer.render(this.scene, this.camera); }
  }

  return { beads, embed, loadThree, Viewer };
});
