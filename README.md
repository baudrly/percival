# Percival

Manual genome scaffolding and curation from Hi-C contact maps, in the browser.

Percival is a hands-on counterpart to [instaGRAAL](https://github.com/koszullab/instagraal): instead of letting an MCMC sample thousands of layouts, you make the edits yourself and see, after every one, exactly how much it changed the likelihood of the contacts. It is meant for teaching, for curating a draft (YaHS, SALSA, 3D-DNA, instaGRAAL output) before submission, and for the handful of fixes where an automated run feels heavy-handed.

Open `index.html` from any static server (`npm start`, then <http://localhost:8000>) or GitHub Pages. Everything runs locally; no data leaves the browser.

## What you can do

- **Edit on the map.** Drag to select a range (edges snap to contig and scaffold ends), then invert, move, excise, unplace or place it. Break and join scaffolds with dedicated tools. Reorder scaffolds by dragging them in the sidebar. Unlimited undo, a clickable history, and autosave in the browser.
- **Follow the evidence.** Tracks above the map show scaffolds, which input contig each piece came from (striped when reversed), coverage, GC content and *junction support*: log₂ observed/expected contacts across every point. Weak junctions, the likely misjoins, are circled on the diagonal.
- **Take hints.** A background search tests breaks at weak junctions, inversions and swaps of blocks, insertions of one scaffold into another and joins of scaffold ends, and ranks them by exact Δ log-likelihood. Hover to preview, apply one, or let it apply hints until none help.
- **See it in other ways.**
  - *3D fold*: a ShRec3D-style embedding (contact frequency → distance → shortest paths → classical MDS) drawn with Three.js. Correct chromosomes fold into territories; misjoins appear as long strands between them.
  - *Decay*: the contact-versus-distance curve for the current and starting layouts against the model.
  - *Links*: a chord diagram of contacts between scaffolds above background, the candidates for joins.
  - *Layout*: a dot plot of current against input position (or against the simulated truth in the demos).
  - Observed/expected, balanced and raw views of the map with adjustable scale, contrast and colour maps, in light and dark themes.
- **Export** AGP 2.1, scaffold FASTA (reverse complements and 100 N gaps), a liftover BED, an instaGRAAL-style `info_frags.txt`, reordered contacts (bg2 or dense matrix), a session file and a PNG of the map.

Two simulated demos are built in: a draft with planted inversions, swaps, a translocation and a misjoin, and 34 shuffled contigs to scaffold into four chromosomes. Both report misjoins and missing joins against the truth.

## The score

Earlier versions used an ad hoc mix of a power-law exponent, an R² and diagonal enrichment. Percival now uses the Poisson likelihood that GRAAL and instaGRAAL sample.

For bins *i* and *j* with biases *b* (from iterative correction, ICE), the count *n<sub>ij</sub>* is Poisson with mean

- *b<sub>i</sub> b<sub>j</sub> P(s<sub>ij</sub>)* when both sit in the same scaffold, *s<sub>ij</sub>* base pairs apart;
- *b<sub>i</sub> b<sub>j</sub> P<sub>trans</sub>* when they sit in different scaffolds.

*P(s)* is measured on the starting layout in logarithmic distance bins, forced to be non-increasing (pool-adjacent-violators), extended beyond the data as a power law fitted by least squares, and floored at *P<sub>trans</sub>*. Up to a constant,

ln *L* = Σ<sub>scaffolds</sub> Σ<sub>i&lt;j</sub> [ *n<sub>ij</sub>* (ln *P(s<sub>ij</sub>)* − ln *P<sub>trans</sub>*) − *b<sub>i</sub> b<sub>j</sub>* (*P(s<sub>ij</sub>)* − *P<sub>trans</sub>*) ]

so only pairs closer than the distance where *P(s)* meets the trans floor contribute, and each scaffold's term is cached by content. A full rescore after an edit on a 2,500-bin map takes tens of milliseconds. The model is frozen so scores stay comparable across edits; refit it from the Decay tab once the layout is mostly right, and every score in the history is recomputed.

Poorly covered bins (under a tenth of the median coverage) are masked: drawn as grey stripes and ignored by the score.

## Input formats

Add files together in the Load dialog; each is recognised from its name and first lines. Plain, gzip and bgzip files are read as they stream (bgzip blocks are inflated in parallel).

| Kind | Formats |
| --- | --- |
| Contacts | Dense square matrix · sparse triplets `i j count` (GRAAL, hicstuff, HiC-Pro `.matrix`; header line and 0/1-based ids detected) · bedgraph2 `chr1 s1 e1 chr2 s2 e2 count` (`cooler dump --join`) · 4DN `.pairs`, binned at the chosen bin size |
| Bins | BED of bins (HiC-Pro `_abs.bed`) · GRAAL/hicstuff `fragments_list.txt` |
| Sequences | FASTA, or lengths only as `.chrom.sizes` / `.fai` |
| Layouts | AGP (to start from an existing scaffolding) · Percival session |

Maps larger than the bin limit (2,500 by default) are coarsened by merging neighbouring bins within each contig.

## Keyboard

| Key | Action |
| --- | --- |
| drag · double-click | select a range · a whole scaffold (hold <kbd>Alt</kbd> to ignore snapping) |
| <kbd>I</kbd> <kbd>M</kbd> <kbd>E</kbd> <kbd>Delete</kbd> | invert · move · excise · unplace or place |
| <kbd>V</kbd> <kbd>K</kbd> <kbd>J</kbd> | select · break · join tools |
| <kbd>H</kbd> | apply the best hint |
| scroll · right-drag or <kbd>Space</kbd>+drag | zoom · pan (two fingers on touch screens) |
| <kbd>Z</kbd> <kbd>0</kbd> | zoom to selection · fit the map |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | undo / redo |

## Code

| File | Contents |
| --- | --- |
| `js/core.js` | DOM-free engine: streaming parsers, dataset assembly, ICE, distance law, likelihood, layout operations, hints, importers and exporters, demo simulator |
| `js/fold3d.js` | 3D embedding and the Three.js viewer (Three.js r128 is loaded from cdnjs when the tab is first opened) |
| `js/app.js` | Interface |
| `css/app.css` | Styles, light and dark themes |
| `tests/` | `npm test` (Node 18+): parsers, operations, likelihood, hints reaching the true assembly, exports, sessions, embedding |

A layout is an immutable pair of arrays: `codes[p] = bin × 2 + reversed` and `cuts[p] = 1` where a scaffold starts, with unplaced pieces after a `debris` index. Every edit returns a new layout, which keeps undo trivial and lets the hint search score candidates without touching the current state.
