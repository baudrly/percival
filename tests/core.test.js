'use strict';
// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../js/core.js');

const blob = text => new Blob([text]);
const permutation = L => [...L.codes].map(c => c >> 1).sort((a, b) => a - b).every((b, k) => b === k);
const demo = P.makeDemo('curation');

test('lnFact matches log factorial', () => {
  assert.equal(P.lnFact(0), 0);
  assert.ok(Math.abs(P.lnFact(5) - Math.log(120)) < 1e-9);
  assert.ok(Math.abs(P.lnFact(20) - 42.335616460753485) < 1e-8);
});

test('FASTA parsing handles CRLF, wrapped lines and gzip', async () => {
  const text = '>a desc\r\nACGT\r\nAC\r\n>b\nGG\n';
  for (const input of [blob(text), new Blob([zlib.gzipSync(text)])]) {
    const r = await P.ingest('x.fa', input);
    assert.equal(r.type, 'fasta');
    assert.equal(Buffer.from(r.seqs.get('a')).toString(), 'ACGTAC');
    assert.equal(Buffer.from(r.seqs.get('b')).toString(), 'GG');
  }
});

test('format sniffing', async () => {
  const cases = [
    ['m.txt', '1 2 0 0\n2 1 0 0\n0 0 1 3\n0 0 3 1\n', 'dense'],
    ['m.txt', 'id_fragA id_fragB n_contact\n0 1 5\n1 2 4\n', 'coo'],
    ['c.bg2', 'chr1\t0\t10\tchr1\t10\t20\t5\n', 'bg2'],
    ['x.pairs', '## pairs format v1.0\n#chromsize: chr1 100\nr1\tchr1\t5\tchr1\t60\t+\t-\n', 'pairs'],
    ['b.bed', 'chr1\t0\t10\nchr1\t10\t20\n', 'bins'],
    ['g.sizes', 'chr1\t100\nchr2\t50\n', 'sizes'],
    ['f.txt', 'id\tchrom\tstart_pos\tend_pos\tsize\tgc_content\n1\tc\t0\t10\t10\t0.4\n', 'frags'],
    ['a.agp', '##agp-version\t2.1\ns1\t1\t10\t1\tW\tc\t1\t10\t+\n', 'agp']
  ];
  for (const [name, text, kind] of cases) assert.equal((await P.ingest(name, blob(text))).kind, kind, name);
});

test('sparse matrix with GRAAL header and 1-based ids', async () => {
  const part = await P.ingest('abs.txt', blob('3 3 3\n1 2 7\n2 3 2\n1 3 1\n'));
  const ds = P.build({ contacts: part }, { binSize: 100 });
  assert.equal(ds.n, 3);
  assert.equal(ds.counts[0 * 3 + 1], 7);
  assert.equal(ds.counts[1 * 3 + 0], 7);
  assert.equal(ds.counts[1 * 3 + 2], 2);
});

test('pairs are binned, symmetric, and tiled across empty bins', async () => {
  const text = '## pairs format v1.0\n#chromsize: chrA 300\n#chromsize: chrB 100\n' +
    'r1\tchrA\t5\tchrA\t250\t+\t+\nr2\tchrA\t5\tchrA\t15\t+\t+\nr3\tchrB\t1\tchrA\t120\t+\t-\n';
  const ds = P.build({ contacts: await P.ingest('x.pairs', blob(text), { binSize: 100 }) });
  assert.deepEqual(ds.contigs.map(c => [c.name, c.count]), [['chrA', 3], ['chrB', 1]]);
  assert.equal(ds.counts[0 * 4 + 0], 1);
  assert.equal(ds.counts[0 * 4 + 2], 1);
  assert.equal(ds.counts[3 * 4 + 1], 1);
  assert.equal(ds.counts[1 * 4 + 3], 1);
});

test('bg2 listing both triangles is not double counted', async () => {
  const text = 'c\t0\t10\tc\t10\t20\t4\nc\t10\t20\tc\t0\t10\t4\nc\t0\t10\tc\t0\t10\t9\n';
  const ds = P.build({ contacts: await P.ingest('x.bg2', blob(text)) });
  assert.equal(ds.counts[1], 4);
  assert.equal(ds.counts[0], 9);
});

test('balancing gives equal coverage', () => {
  const { n, obs, bias } = demo;
  const sums = [];
  for (let i = 0; i < n; i++) {
    if (!(bias[i] > 0)) continue;
    let s = 0;
    for (let j = 0; j < n; j++) if (j !== i) s += obs[i * n + j] / (bias[i] * bias[j]);
    sums.push(s);
  }
  const mean = sums.reduce((a, b) => a + b) / sums.length;
  assert.ok(sums.every(s => Math.abs(s / mean - 1) < 0.01));
});

test('edits keep a permutation and are reversible', () => {
  const L = P.initialLayout(demo), rand = P.rng(3);
  let cur = L;
  for (let k = 0; k < 300; k++) {
    const n = demo.n, a = Math.floor(rand() * (n - 1)), b = a + 1 + Math.floor(rand() * Math.min(40, n - a - 1));
    const r = rand();
    if (r < 0.25) cur = P.ops.invert(cur, a, b);
    else if (r < 0.5) cur = P.ops.move(cur, a, b, Math.floor(rand() * (n + 1)));
    else if (r < 0.65) cur = P.ops.cut(cur, a + 1);
    else if (r < 0.8) cur = P.ops.join(cur, a + 1);
    else if (r < 0.9 && b < cur.debris) cur = P.ops.unplace(cur, a, b);
    else { const c = Math.min(n - 1, b + Math.floor(rand() * 20)), d = Math.min(n, c + 1 + Math.floor(rand() * 10)); cur = P.ops.swap(cur, a, b, c, d); }
    assert.ok(permutation(cur), `step ${k}`);
    assert.equal(cur.cuts[0], 1); assert.equal(cur.cuts[n], 1); assert.equal(cur.cuts[cur.debris], 1);
  }
  const twice = P.ops.invert(P.ops.invert(L, 10, 50), 10, 50);
  assert.deepEqual([...twice.codes], [...L.codes]);
});

test('move keeps scaffold breaks right', () => {
  const L = P.initialLayout(demo), first = demo.contigs[1];
  // moving a whole contig onto a break keeps it separate; into a scaffold it merges
  const apart = P.ops.move(L, first.first, first.first + first.count, 0);
  assert.equal(P.geometry(demo, apart).list.length, demo.contigs.length);
  const merged = P.ops.move(L, first.first, first.first + first.count, 20);
  assert.equal(P.geometry(demo, merged).list.length, demo.contigs.length - 1);
});

test('unplace then place restores a scaffold', () => {
  const L = P.initialLayout(demo), [A] = P.geometry(demo, L).list, len = A.b - A.a;
  const out = P.ops.unplace(L, A.a, A.b);
  assert.equal(out.debris, demo.n - len);
  const back = P.ops.place(out, out.debris, demo.n);
  assert.equal(back.debris, demo.n);
  assert.ok(permutation(back));
  assert.equal(P.geometry(demo, back).list.filter(s => s.placed).length, demo.contigs.length);
});

test('joinEnds touches the requested ends', () => {
  const L = P.initialLayout(demo), [A, , C] = P.geometry(demo, L).list;
  for (const endA of ['head', 'tail']) for (const endB of ['head', 'tail']) {
    const J = P.ops.joinEnds(L, A, endA, C, endB), S = P.geometry(demo, J).list.find(s => s.b - s.a === (A.b - A.a) + (C.b - C.a));
    assert.ok(S, `${endA}/${endB} fused`);
    const aEnd = endA === 'tail' ? L.codes[A.b - 1] : L.codes[A.a], cEnd = endB === 'tail' ? L.codes[C.b - 1] : L.codes[C.a];
    const k = [...J.codes].findIndex(c => c >> 1 === aEnd >> 1), m = [...J.codes].findIndex(c => c >> 1 === cEnd >> 1);
    assert.equal(Math.abs(k - m), 1, `${endA}/${endB} adjacent`);
  }
});

test('likelihood prefers the true assembly and hints reach it', () => {
  const L0 = P.initialLayout(demo), sc = new P.Scorer(demo, P.fitModel(demo, L0));
  const truth = P.truthLayout(demo);
  assert.ok(sc.score(truth) > sc.score(L0) + 1000);
  let L = L0;
  for (let k = 0; k < 30; k++) {
    const g = sc.suggest(L); let r; do r = g.next(); while (!r.done);
    if (!r.value.hints.length) break;
    const h = r.value.hints[0];
    assert.ok(Math.abs(sc.score(h.layout) - sc.score(L) - h.delta) < 1e-6);
    L = h.layout;
  }
  const st = P.stats(demo, L);
  assert.equal(st.misjoins, 0);
  assert.equal(st.missing, 0);
});

test('weak junctions flag planted misjoins', () => {
  const L0 = P.initialLayout(demo), sc = new P.Scorer(demo, P.fitModel(demo, L0));
  const { weak } = sc.junctions(L0), truthBreaks = [];
  for (let p = 1; p < demo.n; p++) {
    if (L0.cuts[p]) continue;
    const i = L0.codes[p - 1] >> 1, j = L0.codes[p] >> 1;
    if (Math.abs(demo.truth.pos[i] - demo.truth.pos[j]) !== 1) truthBreaks.push(p);
  }
  const found = truthBreaks.filter(p => weak.some(q => Math.abs(q - p) <= 2)).length;
  assert.ok(found >= truthBreaks.length - 1, `${found} of ${truthBreaks.length}`);
});

test('exports: AGP round trip, FASTA reverse complement, info_frags', async () => {
  const truth = P.truthLayout(demo);
  const agp = P.exporters.agp(demo, truth);
  const back = P.layoutFromAgp(demo, (await P.ingest('t.agp', blob(agp))).rows);
  assert.deepEqual([...back.codes], [...truth.codes]);
  const fasta = Buffer.concat(P.exporters.fasta(demo, truth).map(c => Buffer.from(c))).toString();
  const seqs = fasta.split('>').slice(1).map(r => r.split('\n').slice(1).join('').replace(/N{100}/g, ''));
  seqs.forEach((s, c) => assert.equal(s, Buffer.from(demo.truth.seqs[c]).toString(), `chromosome ${c + 1}`));
  const frags = P.exporters.infoFrags(demo, truth).split('\n').filter(l => /^draft/.test(l));
  assert.equal(frags.length, demo.n);
});

test('session round trip and mismatch detection', () => {
  const L = P.ops.invert(P.initialLayout(demo), 5, 60), s = JSON.parse(JSON.stringify(P.sessionOf(demo, L, [])));
  assert.deepEqual([...P.layoutFromSession(demo, s).codes], [...L.codes]);
  assert.throws(() => P.layoutFromSession(demo, { ...s, bins: 3 }), /different map/);
});

test('coarsening keeps contigs separate', () => {
  const big = P.build({ contacts: { n: demo.n, data: (() => { const d = new Float32Array(demo.n ** 2); d.set(demo.counts); return d; })() },
    bins: { chrom: demo.contigs.flatMap(c => Array(c.count).fill(c.name)), start: [...demo.binStart], end: [...demo.binEnd] } }, { maxBins: 150 });
  assert.ok(big.n <= 150 + demo.contigs.length);
  assert.equal(big.contigs.length, demo.contigs.length);
  const sum = m => m.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum(big.counts) - sum(demo.counts)) < 1e-3 * sum(demo.counts));
});

test('3D embedding keeps chromosomes apart and stays finite', () => {
  const F = require('../js/fold3d.js'), L = P.truthLayout(demo), list = F.beads(demo, L, 0, demo.n, 120);
  assert.ok(list.length <= 120 + demo.truth.chroms);
  assert.ok(list.every(b => !L.cuts.slice(b.a + 1, b.b).some(Boolean)), 'beads never straddle a break');
  const xyz = F.embed(demo, L, list), centre = new Map();
  assert.ok(xyz.every(Number.isFinite));
  list.forEach((b, u) => { const c = centre.get(b.chain) || [0, 0, 0, 0]; for (let a = 0; a < 3; a++) c[a] += xyz[u * 3 + a]; c[3]++; centre.set(b.chain, c); });
  const spread = list.reduce((s, b, u) => { const c = centre.get(b.chain); return s + Math.hypot(...[0, 1, 2].map(a => xyz[u * 3 + a] - c[a] / c[3])); }, 0) / list.length;
  const cs = [...centre.values()].map(c => c.slice(0, 3).map(v => v / c[3]));
  let apart = Infinity;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) apart = Math.min(apart, Math.hypot(...[0, 1, 2].map(a => cs[i][a] - cs[j][a])));
  assert.ok(apart > spread, `territories ${apart.toFixed(2)} apart, beads ${spread.toFixed(2)} from their centre`);
});
