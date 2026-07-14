#!/usr/bin/env node
// family-without-law — OFFLINE, read-only "family miner" (C8 slice 4). Makes ZERO LLM
// calls, and it NEVER creates or writes any aspect (stability law V2): it only PROPOSES
// candidate families as telemetry. It is a standalone `node scripts/family-without-law.mjs`
// — NOT wired into `yg`, with no effect on any exit code, verdict, issue, or suggestedNext.
// Its one write is the gitignored `.yggdrasil/.family-candidates.json` data file (Task 2's
// `yg advise` reads it); the write is best-effort and never throws into the caller.
//
// WHAT: within each language stratum, it clusters source files that are structurally
// near-identical (a TIGHT cluster, robust median/MAD distance below a parameter threshold)
// yet share NO NARROW rule that would already be their law — and for each such cluster it
// CUTS a fitted applicability predicate (a minimatch glob over the shared path structure, or
// a content regex over a shared structural signature) so the proposed rule is born WITH its
// reach evidence. Structural feature vectors are the wave-6 per-file `features` the AST fact
// shards carry (facts-cache.ts: `FeatureVector` — nodeCount, depth quartiles, six category
// counts); this miner reads them through the CLI's own read-only calibration surface
// (`yg check --attention-dump`), so it never re-implements the content-addressed shard-key
// derivation (which would silently rot on a grammar/rev bump) and it inherits the engine's
// exact ownership resolution. Declared aspect attachments + the node hierarchy are read
// directly from the committed graph (`.yggdrasil/model/**`) as data.
//
// WHY: a cluster of structurally-uniform files with no shared narrow law is the signature of
// a rule that OUGHT to exist but does not — a "family without a law". Surfacing it (with a
// ready-cut scope) turns a latent, invisible convention into a concrete, human-reviewable
// nomination. It is deliberately a PROPOSAL STREAM for a person to read, never a gate and
// never an auto-created aspect.
//
// NEAR-VACUOUS CAVEAT (printed verbatim below and documented in aspects/README.md):
//   Note: "no shared aspect" is near-vacuous — type-default and broad-parent cascades are
//   excluded, so a family fires only when the cluster shares no NARROW (own / port /
//   narrow-ancestor) aspect that would already be its law.
//
// ADMISSION CONTROL (RZ-21): this surface is admitted into `yg advise` (Task 2) ONLY after
// proven precision at BUILD time — the planted-family fixtures assert exact recall + zero
// false families and byte-identical determinism. That evidence gate, not any elapsed time,
// is what lets a family be shown.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Tuning policy (documented change policy — RZ-21) ─────────────────────────
// Every threshold below is an EVIDENCE-tuned parameter, not a calendar knob. The
// this-repo precision gate is the calibrator: run the miner at the repo root, inspect
// every reported family for human plausibility, and if a family is IMPLAUSIBLE, raise the
// tightness BAR — i.e. LOWER TIGHTNESS_MEDIAN_MAX (and, if it is a chained cluster, lower
// LINKAGE_CUTOFF) — in small steps until only plausible families remain. Never widen a
// threshold merely to surface more; this surface's whole value is precision.
//
// Each threshold below reads an optional env override (YG_FAMILY_* ) so a maintainer can
// sweep values during a recalibration WITHOUT editing the script; the DEFAULT baked in here
// is the shipped, committed policy value, so the miner's normal behaviour is deterministic
// and needs no environment at all. (Mirrors how the engine's Z_ADMIT is recalibrated via
// the read-only `--attention-dump` lens.)
const numEnv = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

/** Minimum members for a cluster to be a family. Five near-identical files is the smallest
 *  set worth naming; below that the "pattern" is anecdote, not a law. */
const MIN_CLUSTER_SIZE = Math.round(numEnv('YG_FAMILY_MIN', 5));

/** Complete-linkage DIAMETER cutoff, in robust (MAD-scaled) distance units. Complete linkage
 *  guarantees every pair in a formed cluster is within this bound, which prevents single-link
 *  CHAINING (two dense blobs joined by a bridge file) from fabricating a family. */
const LINKAGE_CUTOFF = numEnv('YG_FAMILY_LINKAGE', 1.5);

/** The TRIGGER threshold: a formed cluster is "tight" only when the MEDIAN of its pairwise
 *  robust distances is at or below this. Median/MAD, never mean/σ — a single wilder member
 *  must not drag the centre it is measured against. This is the primary calibration knob;
 *  LOWER it to tighten the bar (fewer, more plausible families). */
const TIGHTNESS_MEDIAN_MAX = numEnv('YG_FAMILY_TIGHT', 0.75);

/** Reach cutoff for "narrow ancestor". An ancestor node whose subtree owns MORE than this
 *  many mined files is a BROAD parent: its aspects blanket far more than the family, so they
 *  are type-of-cascade noise, not the family's own law, and are excluded from the shared-law
 *  test (channel 2 from a high ancestor). Own (channel 1) and port (channel 6) attachments
 *  are always narrow. Type-default cascades (channels 3/4) never appear in a node's written
 *  `aspects:` at all, so they are excluded by construction. */
const BROAD_ANCESTOR_MAX_FILES = 40;

/** Safety cap: a stratum larger than this is skipped (the O(k^2) clustering is a one-shot
 *  analysis, not a hot path). No real graph approaches this; the cap only bounds pathology. */
const MAX_STRATUM_FILES = 4000;

/** A shared filename affix (prefix or suffix, minus the extension) is only "discriminating"
 *  when it carries an alphanumeric run of at least this length — `Repository.ts` qualifies,
 *  a bare `.ts` does not. */
const MIN_AFFIX_TOKEN = 3;

/** MAD → σ rescale, matching the engine's feature-field statistic so "robust distance units"
 *  mean the same thing here as in the anomaly layer. */
const MAD_SCALE = 1.4826;

const CAVEAT =
  'Note: "no shared aspect" is near-vacuous — type-default and broad-parent cascades are ' +
  'excluded, so a family fires only when the cluster shares no NARROW (own / port / ' +
  'narrow-ancestor) aspect that would already be its law.';

/** Repo-relative POSIX path segments that mark test / scaffolding / derived trees. A mined
 *  file under any of these is skipped when mining a whole repo, so throwaway test families
 *  (including this project's own planted fixtures) are never proposed as product laws. When
 *  the miner is pointed AT a fixture root, that fixture's files sit under `src/…` and are
 *  mined normally — the exclusion is always relative to the mining root. */
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tests',
  'test',
  '__tests__',
  'fixtures',
  '.yggdrasil',
  '.git',
]);

const FEATURE_CATEGORIES = [
  'function-like',
  'class-like',
  'import-like',
  'branch-like',
  'call-like',
  'literal-like',
];

// ── Locations (script-relative, independent of the mining root) ──────────────
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(SCRIPT_DIR, '..', 'source', 'cli');
const DIST_BIN = path.join(CLI_DIR, 'dist', 'bin.js');
const require = createRequire(path.join(CLI_DIR, 'package.json'));
const YAML = require('yaml');

const OUTPUT_BASENAME = '.family-candidates.json';
const out = (m = '') => process.stdout.write(m + '\n');
// Diagnostics go to STDERR and only when YG_FAMILY_DEBUG is set — never to stdout (the roster)
// or the JSON output, so turning it on can never perturb the mined result or its determinism.
const DEBUG = !!process.env.YG_FAMILY_DEBUG;
const debug = (m) => {
  if (DEBUG) process.stderr.write('[family-debug] ' + m + '\n');
};

// ── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { root: process.cwd(), ts: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i] ?? '.');
    else if (a.startsWith('--root=')) args.root = path.resolve(a.slice('--root='.length));
    else if (a === '--ts') args.ts = argv[++i] ?? null;
    else if (a.startsWith('--ts=')) args.ts = a.slice('--ts='.length);
  }
  return args;
}

// ── Robust statistics (median / MAD, never mean/σ) ───────────────────────────
function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mad(nums, med) {
  return median(nums.map((x) => Math.abs(x - med)));
}

// ── Minimatch-ish glob → RegExp (mirrors the graph's mapping semantics) ──────
function globToRegExp(glob) {
  let g = glob.endsWith('/') ? glob + '**' : glob;
  g = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  g = g
    .replace(/\/\*\*\//g, '<<GSS>>')
    .replace(/^\*\*\//g, '<<GSHEAD>>')
    .replace(/\/\*\*$/g, '<<GSTAIL>>')
    .replace(/\*\*/g, '<<GS>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  g = g
    .replace(/<<GSS>>/g, '/(?:[^/]+/)*')
    .replace(/<<GSHEAD>>/g, '(?:[^/]+/)*')
    .replace(/<<GSTAIL>>/g, '(?:/.*)?')
    .replace(/<<GS>>/g, '.*');
  return new RegExp('^' + g + '$');
}

// ── Graph reading (committed model/, directly as data) ───────────────────────
// Collect every node's declared type + aspect attachments + ports + relations, keyed by
// node id (the `model/`-relative POSIX directory). Aspect entries may be bare strings or
// `{ id, when, status }` objects — only the id matters for the shared-law test.
function loadNodes(graphRoot) {
  const modelDir = path.join(graphRoot, 'model');
  const byId = new Map();
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(absDir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'yg-node.yaml') {
        const id = path.relative(modelDir, path.dirname(p)).split(path.sep).join('/');
        let doc;
        try {
          doc = YAML.parse(readFileSync(p, 'utf-8')) ?? {};
        } catch {
          continue; // unparseable node → treated as unknown (contributes no law)
        }
        byId.set(id === '' ? '.' : id, {
          type: typeof doc.type === 'string' ? doc.type : null,
          aspects: aspectIdsOf(doc.aspects),
          ports: portAspectsOf(doc.ports),
          relations: Array.isArray(doc.relations) ? doc.relations : [],
        });
      }
    }
  };
  walk(modelDir);
  return byId;
}
function aspectIdsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const a of raw) {
    if (typeof a === 'string') ids.push(a);
    else if (a && typeof a === 'object' && typeof a.id === 'string') ids.push(a.id);
  }
  return ids;
}
function portAspectsOf(raw) {
  const map = new Map();
  if (raw && typeof raw === 'object') {
    for (const [name, def] of Object.entries(raw)) {
      if (def && typeof def === 'object') map.set(name, aspectIdsOf(def.aspects));
    }
  }
  return map;
}
/** Strict ancestor ids of a node id, root-first: `a/b/c` → [`a`, `a/b`]. */
function ancestorsOf(id) {
  if (id === '.' || id === '') return [];
  const segs = id.split('/');
  const acc = [];
  for (let i = 1; i < segs.length; i++) acc.push(segs.slice(0, i).join('/'));
  return acc;
}

// ── Feature-vector acquisition via the CLI's read-only calibration surface ───
// Spawns `yg check --attention-dump` (writes nothing, makes no LLM calls) in the mining
// root and parses its per-file structural counts. Returns records { owner, language, path,
// vector[10] } in the DIMS order: nodeCount, depthQ25/50/75, then the six category counts.
function collectVectors(root) {
  const res = spawnSync(process.execPath, [DIST_BIN, 'check', '--attention-dump'], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 512 * 1024 * 1024,
  });
  // Fail LOUDLY on a failed/partial dump rather than silently mining a truncated read (which
  // would drop files and could hide a family). The dump is a read-only instrument that exits 0
  // even on a repo with check errors, so a non-zero status is a real infrastructure failure.
  if (res.error) {
    throw new Error(
      `family-without-law: could not run the feature dump (${res.error.message}). ` +
        `Build the CLI first: (cd source/cli && npm run build).`,
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `family-without-law: the feature dump exited with status ${res.status} — refusing to mine a ` +
        `partial read. Stderr:\n${(res.stderr ?? '').slice(0, 2000)}`,
    );
  }
  const text = (res.stdout ?? '') + '';
  const records = [];
  // The family header is `<owner> · <language>  (…)`. `(.*?)` (not `.+?`) tolerates a model-ROOT
  // node whose id is the empty string, so a root-mapped file is not silently skipped; the empty
  // owner is normalized to '.' to match loadNodes (which keys the root node under '.').
  const headerRe = /^(.*?) · (\S+)\s+\(/;
  const vecRe =
    /^ {6}size=(\d+) nest=(\d+)\/(\d+)\/(\d+) fn=(\d+) cls=(\d+) imp=(\d+) br=(\d+) call=(\d+) lit=(\d+)/;
  let owner = null;
  let language = null;
  let pendingPath = null;
  for (const line of text.split('\n')) {
    const h = headerRe.exec(line);
    if (h) {
      owner = h[1] === '' ? '.' : h[1];
      language = h[2];
      pendingPath = null;
      continue;
    }
    const v = vecRe.exec(line);
    if (v) {
      if (pendingPath !== null && owner !== null && language !== null) {
        const n = v.slice(1).map((x) => Number(x));
        records.push({
          owner,
          language,
          path: pendingPath,
          // [nodeCount, dQ25, dQ50, dQ75, fn, cls, imp, br, call, lit]
          vector: [n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8], n[9]],
        });
      }
      pendingPath = null;
      continue;
    }
    // A file path line: two-space indent, no `size=` payload.
    const m = /^ {2}(\S.*)$/.exec(line);
    if (m && owner !== null) pendingPath = m[1].trim();
  }
  return records;
}

function isExcludedPath(p) {
  return p.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg));
}

// ── Narrow-law resolution (own / port / narrow-ancestor) ─────────────────────
// Build the set of NARROW aspect ids effective on an owner node, walking the same cascade
// channels the verifier uses but keeping ONLY the narrow ones. subtreeCount pins ancestor
// reach so a broad parent's aspect is excluded.
function makeNarrowLaw(nodes, subtreeCount) {
  const cache = new Map();
  return function narrowLawOf(owner) {
    if (cache.has(owner)) return cache.get(owner);
    const ids = new Set();
    const node = nodes.get(owner);
    if (node) {
      for (const a of node.aspects) ids.add(a); // channel 1 — own (always narrow)
      for (const rel of node.relations) {
        // channel 6 — port: a `consumes`d port's aspects become the consumer's law
        if (rel && typeof rel === 'object' && Array.isArray(rel.consumes)) {
          const target = nodes.get(rel.target);
          if (target) {
            for (const portName of rel.consumes) {
              for (const a of target.ports.get(portName) ?? []) ids.add(a);
            }
          }
        }
      }
    }
    for (const anc of ancestorsOf(owner)) {
      // channel 2 — narrow ancestor only (a broad parent's cascade is excluded)
      if ((subtreeCount.get(anc) ?? 0) > BROAD_ANCESTOR_MAX_FILES) continue;
      const an = nodes.get(anc);
      if (an) for (const a of an.aspects) ids.add(a);
    }
    cache.set(owner, ids);
    return ids;
  };
}

// ── Robust per-dimension scaling within a stratum ────────────────────────────
// Returns a scale[10] where scale[d] = 1/(MAD_SCALE*spread_d), with spread_d a robust measure
// of within-stratum spread, or 0 for a truly CONSTANT dimension (no information → weight 0).
//
// The spread is the MAD (median absolute deviation). But the MAD COLLAPSES to zero whenever
// at least half the files share the exact median value — which is exactly what a dominant
// near-identical family does in a small stratum (e.g. five identical repositories among nine
// files). A zero MAD there would drop EVERY dimension and make every file distance-0, so no
// family could ever separate. When the MAD is zero yet the dimension still has real spread
// (some files deviate), we fall back to the median of the NON-ZERO absolute deviations — a
// robust spread of the files that DO differ. Only a dimension with no spread at all (every
// value equal) is dropped. This keeps the statistic median-based (never mean/σ) while staying
// well-defined on the dominant-family case the precision fixtures pin.
function robustScales(vectors) {
  const dims = vectors[0].length;
  const scale = new Array(dims).fill(0);
  for (let d = 0; d < dims; d++) {
    const col = vectors.map((v) => v[d]);
    const m = median(col);
    let spread = mad(col, m);
    if (spread === 0) {
      const nonzeroDevs = col.map((x) => Math.abs(x - m)).filter((x) => x > 0);
      spread = nonzeroDevs.length > 0 ? median(nonzeroDevs) : 0;
    }
    scale[d] = spread > 0 ? 1 / (MAD_SCALE * spread) : 0;
  }
  return scale;
}
function scaledDistance(a, b, scale) {
  let sum = 0;
  for (let d = 0; d < a.length; d++) {
    const s = scale[d];
    if (s === 0) continue;
    const diff = (a[d] - b[d]) * s;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// ── Deterministic complete-linkage agglomerative clustering ──────────────────
// Merges the closest pair of clusters (cluster distance = MAX pairwise member distance —
// complete linkage, so no chaining) while that distance is <= LINKAGE_CUTOFF. Ties break on
// the merged cluster's sorted-member key so two runs are byte-identical. `idx` are indices
// into `dist` (the precomputed pairwise matrix). Returns clusters as arrays of indices.
function completeLinkage(n, dist) {
  // Active clusters: each is { members: sorted index array, key: members.join(',') }.
  let clusters = [];
  for (let i = 0; i < n; i++) clusters.push({ members: [i], key: String(i) });

  // Cluster-cluster distances via Lance-Williams max update, keyed by cluster ordinal.
  const cd = new Map(); // "i,j" (i<j ordinals) -> distance
  const pairKey = (i, j) => (i < j ? i + ',' + j : j + ',' + i);
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      cd.set(pairKey(i, j), dist[clusters[i].members[0]][clusters[j].members[0]]);
    }
  }

  while (clusters.length > 1) {
    // Find the closest mergeable pair (deterministic tie-break on merged key).
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = cd.get(pairKey(i, j));
        if (d > LINKAGE_CUTOFF) continue;
        if (best === null) {
          best = { i, j, d };
          continue;
        }
        if (d < best.d - 1e-12) {
          best = { i, j, d };
        } else if (Math.abs(d - best.d) <= 1e-12) {
          const cand = mergedKey(clusters[i], clusters[j]);
          const cur = mergedKey(clusters[best.i], clusters[best.j]);
          if (cand < cur) best = { i, j, d };
        }
      }
    }
    if (best === null) break; // nothing left within the cutoff

    const { i, j } = best;
    const merged = {
      members: [...clusters[i].members, ...clusters[j].members].sort((a, b) => a - b),
      key: '',
    };
    merged.key = merged.members.join(',');

    // Rebuild cluster distances against the merged cluster (complete-linkage = max).
    const survivors = [];
    for (let k = 0; k < clusters.length; k++) if (k !== i && k !== j) survivors.push(k);
    const newClusters = survivors.map((k) => clusters[k]);
    const newIndexOf = new Map(survivors.map((k, idx) => [k, idx]));
    const newCd = new Map();
    for (let a = 0; a < survivors.length; a++) {
      for (let b = a + 1; b < survivors.length; b++) {
        newCd.set(a + ',' + b, cd.get(pairKey(survivors[a], survivors[b])));
      }
    }
    const mergedOrdinal = newClusters.length;
    for (let a = 0; a < survivors.length; a++) {
      const k = survivors[a];
      const dMerged = Math.max(cd.get(pairKey(i, k)), cd.get(pairKey(j, k)));
      newCd.set(pairKey(newIndexOf.get(k), mergedOrdinal), dMerged);
    }
    newClusters.push(merged);
    clusters = newClusters;
    cd.clear();
    for (const [key, value] of newCd) cd.set(key, value);
  }

  return clusters.map((c) => c.members);
}
function mergedKey(a, b) {
  return [...a.members, ...b.members].sort((x, y) => x - y).join(',');
}

// ── Fitted predicate — cut from the cluster's shared path / structure ────────
function commonAffix(strings, side) {
  if (strings.length === 0) return '';
  let ref = strings[0];
  for (const s of strings.slice(1)) {
    let k = 0;
    const max = Math.min(ref.length, s.length);
    while (k < max) {
      const ca = side === 'suffix' ? ref[ref.length - 1 - k] : ref[k];
      const cb = side === 'suffix' ? s[s.length - 1 - k] : s[k];
      if (ca !== cb) break;
      k++;
    }
    ref = side === 'suffix' ? ref.slice(ref.length - k) : ref.slice(0, k);
    if (ref === '') break;
  }
  return ref;
}
function hasToken(affix) {
  const stripped = affix.replace(/\.[A-Za-z0-9]+$/, ''); // ignore a trailing extension
  return /[A-Za-z0-9]{3,}/.test(stripped) && stripped.replace(/[^A-Za-z0-9]/g, '').length >= MIN_AFFIX_TOKEN;
}
function longestCommonDir(paths) {
  const split = paths.map((p) => p.split('/').slice(0, -1));
  let common = split[0];
  for (const segs of split.slice(1)) {
    let k = 0;
    while (k < common.length && k < segs.length && common[k] === segs[k]) k++;
    common = common.slice(0, k);
  }
  return common.join('/');
}
/** Build a fitted predicate for a cluster of repo-rel POSIX paths. Prefers a discriminating
 *  glob over shared path structure; falls back to a content regex over a shared structural
 *  signature line. Returns null when no candidate is BOTH discriminating AND faithful — a
 *  proposed rule must come WITH honest reach evidence, so a predicate that would over-reach a
 *  same-stratum non-member (a file that did NOT cluster) is rejected rather than shown.
 *  `nonMembers` are the same-language stratum paths NOT in this cluster. */
function fitPredicate(paths, root, nonMembers) {
  const basenames = paths.map((p) => p.split('/').pop());
  const suffix = commonAffix(basenames, 'suffix');
  const prefix = commonAffix(basenames, 'prefix');

  // Per-directory grouping (for the tightest per-dir scope skeleton).
  const byDir = new Map();
  for (const p of paths) {
    const dir = p.split('/').slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(p.split('/').pop());
  }

  // FAITHFULNESS gate (RZ-21): a glob is faithful only if it matches NO non-member PATH; every
  // scopeFilesDraft glob is checked too, so a per-dir draft can never silently over-reach a
  // non-member the fitted predicate happened to exclude.
  const globExcludesNonMembers = (globValue) => {
    const re = globToRegExp(globValue);
    return nonMembers.every((p) => !re.test(p));
  };
  const scopeExcludesNonMembers = (scopeFiles) => scopeFiles.every((sf) => globExcludesNonMembers(sf));

  const build = (affix, side) => {
    const scopeFilesDraft = [
      ...new Set(
        [...byDir.keys()].map((dir) => {
          const a = commonAffix(byDir.get(dir), side);
          return side === 'suffix' ? `${dir}/*${a}` : `${dir}/${a}*`;
        }),
      ),
    ].sort();
    const commonDir = longestCommonDir(paths);
    const dirs = new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')));
    const value =
      side === 'suffix'
        ? dirs.size === 1
          ? `${[...dirs][0]}/*${affix}`
          : `${commonDir}/**/*${affix}`
        : dirs.size === 1
          ? `${[...dirs][0]}/${affix}*`
          : `${commonDir}/**/${affix}*`;
    const re = globToRegExp(value);
    if (!paths.every((p) => re.test(p))) return null; // must COVER every member
    // commonAffix already returns the LONGEST shared affix (the tightest same-side glob), so if
    // this still over-reaches a non-member there is no tighter same-side glob to fall back to.
    if (!globExcludesNonMembers(value)) return null; // must EXCLUDE every non-member (faithful)
    if (!scopeExcludesNonMembers(scopeFilesDraft)) return null;
    return { fittedPredicate: { kind: 'glob', value }, scopeFilesDraft };
  };

  // Try suffix then prefix; take the FIRST candidate that both covers all members and excludes
  // all non-members.
  if (hasToken(suffix)) {
    const g = build(suffix, 'suffix');
    if (g) return g;
  }
  if (hasToken(prefix)) {
    const g = build(prefix, 'prefix');
    if (g) return g;
  }

  // Fallback: a content regex over a structural declaration line shared by ALL members — kept
  // only if it matches no non-member's CONTENT and its per-dir scope draft excludes every
  // non-member PATH (so a member directory that also holds non-members can never over-reach).
  const regex = fitStructuralRegex(paths, root);
  if (regex) {
    const scopeFilesDraft = [
      ...new Set(
        [...byDir.keys()].map((dir) => {
          const ext = (paths.find((p) => p.startsWith(dir + '/')) ?? '').split('.').pop();
          return `${dir}/*.${ext}`;
        }),
      ),
    ].sort();
    const re = new RegExp(regex);
    const regexExcludesNonMembers = nonMembers.every((p) => {
      let text;
      try {
        text = readFileSync(path.join(root, p), 'utf-8');
      } catch {
        return true; // a stratum file is known-parseable; a transient read miss is not evidence of a match
      }
      return !re.test(text);
    });
    if (regexExcludesNonMembers && scopeExcludesNonMembers(scopeFilesDraft)) {
      return { fittedPredicate: { kind: 'regex', value: regex }, scopeFilesDraft };
    }
  }
  return null;
}

const DECL_RE =
  /^(export\s+)?(default\s+)?(abstract\s+)?(public\s+|private\s+|protected\s+)?(class|interface|struct|trait|enum|record|def|fn|function|type)\s+([A-Za-z_]\w*)/;
/** Read the member files and find a declaration line present (as a normalized template) in
 *  ALL members; return it as a regex with the declared identifier generalized to `\w+`. */
function fitStructuralRegex(paths, root) {
  const perFile = [];
  for (const p of paths) {
    let text;
    try {
      text = readFileSync(path.join(root, p), 'utf-8');
    } catch {
      return null;
    }
    const templates = new Set(); // normalized declaration lines, e.g. `export class NAME {`
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const m = DECL_RE.exec(line);
      if (!m) continue;
      // Replace the declared identifier (m[6]) with a placeholder, then collapse whitespace.
      const norm = line.replace(m[6], ' NAME ').replace(/\s+/g, ' ');
      templates.add(norm);
    }
    perFile.push(templates);
  }
  // Intersection of normalized declaration templates across every member.
  let shared = null;
  for (const templates of perFile) {
    shared = shared === null ? templates : new Set([...shared].filter((k) => templates.has(k)));
    if (shared.size === 0) return null;
  }
  if (!shared || shared.size === 0) return null;
  const chosen = [...shared].sort()[0]; // deterministic pick
  // Escape regex metacharacters, then swap the ` NAME ` placeholder for an identifier matcher
  // (surrounding spaces preserved): `export class NAME {` -> `export class \w+ {`.
  const escaped = chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.split(' NAME ').join(' \\w+ ');
}

// ── Per-stratum family detection ─────────────────────────────────────────────
function minePairwise(records, narrowLawOf, root) {
  const families = [];
  const byLang = new Map();
  for (const r of records) {
    if (!byLang.has(r.language)) byLang.set(r.language, []);
    byLang.get(r.language).push(r);
  }

  for (const [language, recs] of byLang) {
    if (recs.length < MIN_CLUSTER_SIZE) continue;
    if (recs.length > MAX_STRATUM_FILES) continue; // pathology guard
    // Stable order for deterministic clustering (paths are unique within a stratum).
    recs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const vectors = recs.map((r) => r.vector);
    const scale = robustScales(vectors);

    const n = recs.length;
    const dist = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const d = scaledDistance(vectors[i], vectors[j], scale);
        dist[i][j] = d;
        dist[j][i] = d;
      }

    for (const cluster of completeLinkage(n, dist)) {
      if (cluster.length < MIN_CLUSTER_SIZE) continue;
      const pairwise = [];
      for (let a = 0; a < cluster.length; a++)
        for (let b = a + 1; b < cluster.length; b++) pairwise.push(dist[cluster[a]][cluster[b]]);
      const medDist = median(pairwise);
      const memberPaths = cluster.map((idx) => recs[idx].path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (medDist > TIGHTNESS_MEDIAN_MAX) {
        debug(`SKIP ${language} cluster(${cluster.length}) medDist=${medDist.toFixed(3)} > tight → not tight [${memberPaths[0]} …]`);
        continue; // not tight enough (median/MAD trigger)
      }

      // Shared NARROW law = intersection of each member's narrow aspect set. Fire only when
      // empty: the cluster shares no own/port/narrow-ancestor aspect that is already its law.
      let sharedLaw = null;
      for (const idx of cluster) {
        const law = narrowLawOf(recs[idx].owner);
        sharedLaw = sharedLaw === null ? new Set(law) : new Set([...sharedLaw].filter((a) => law.has(a)));
      }
      if (sharedLaw && sharedLaw.size > 0) {
        debug(`SKIP ${language} cluster(${cluster.length}) medDist=${medDist.toFixed(3)} shares law {${[...sharedLaw].join(',')}} [${memberPaths[0]} …]`);
        continue; // already has a shared narrow law → not a gap
      }

      const members = memberPaths;
      // Faithful-reach check runs against the WHOLE stratum's non-members (same language, did
      // not cluster) — a fitted predicate that over-reaches any of them is not born WITH honest
      // reach evidence and the family is dropped.
      const memberSet = new Set(members);
      const nonMembers = recs.map((r) => r.path).filter((p) => !memberSet.has(p));
      const fitted = fitPredicate(members, root, nonMembers);
      if (!fitted) {
        debug(`SKIP ${language} cluster(${cluster.length}) medDist=${medDist.toFixed(3)} no faithful predicate (unfittable or over-reaches a non-member) [${members.join(', ')}]`);
        continue; // no discriminating, non-over-reaching reach evidence → not proposable
      }
      debug(`FIRE ${language} cluster(${cluster.length}) medDist=${medDist.toFixed(3)} → ${fitted.fittedPredicate.value}`);

      const stableKey = createHash('sha256').update(members.join('\n')).digest('hex').slice(0, 12);
      const tightness = Math.round((1 / (1 + medDist)) * 100) / 100;
      families.push({
        id: `family-${language}-${stableKey}`,
        language,
        members,
        fittedPredicate: fitted.fittedPredicate,
        scopeFilesDraft: fitted.scopeFilesDraft,
        evidence: { clusterSize: members.length, tightness, sharedDiscriminatingAspects: [] },
      });
    }
  }

  families.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return families;
}

// ── Output writer (atomic, gitignore-self-ensuring, best-effort) ─────────────
function ensureGitignored(graphRoot) {
  const giPath = path.join(graphRoot, '.gitignore');
  try {
    let existing = '';
    if (existsSync(giPath)) existing = readFileSync(giPath, 'utf-8');
    const present = new Set(existing.split('\n').map((l) => l.trim()));
    if (present.has(OUTPUT_BASENAME)) return;
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(giPath, `${existing}${sep}${OUTPUT_BASENAME}\n`);
  } catch {
    /* best-effort: a gitignore write failure never fails the miner */
  }
}
function writeCandidates(graphRoot, payload) {
  try {
    ensureGitignored(graphRoot);
    mkdirSync(graphRoot, { recursive: true });
    const target = path.join(graphRoot, OUTPUT_BASENAME);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, target);
    return target;
  } catch {
    return null; // never throw into the caller — this is telemetry
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const { root, ts } = parseArgs(process.argv.slice(2));
  const graphRoot = path.join(root, '.yggdrasil');
  const stamp = ts ?? process.env.YG_FAMILY_TS ?? new Date().toISOString();

  out('family-without-law — offline family miner (proposals only; never a gate, never writes an aspect).');
  out('Read-only. ZERO LLM calls. NEVER creates or writes any aspect (stability law V2).');
  out(CAVEAT);
  out('');

  if (!existsSync(path.join(graphRoot, 'model'))) {
    out(`No graph found at ${graphRoot}/model — nothing to mine.`);
    return;
  }
  if (!existsSync(DIST_BIN)) {
    out(`CLI build not found at ${DIST_BIN}. Build it first: (cd source/cli && npm run build).`);
    return;
  }

  const nodes = loadNodes(graphRoot);
  const allRecords = collectVectors(root);
  const records = allRecords.filter((r) => !isExcludedPath(r.path));

  // Subtree mined-file reach per node (for the narrow-ancestor cutoff).
  const subtreeCount = new Map();
  for (const r of records) {
    const chain = [r.owner, ...ancestorsOf(r.owner)];
    for (const id of chain) subtreeCount.set(id, (subtreeCount.get(id) ?? 0) + 1);
  }
  const narrowLawOf = makeNarrowLaw(nodes, subtreeCount);

  const coverage = [...new Set(records.map((r) => r.language))].sort();
  const families = minePairwise(records, narrowLawOf, root);

  const payload = { v: 1, ts: stamp, coverage, families };
  const written = writeCandidates(graphRoot, payload);

  // ── Human roster ───────────────────────────────────────────────────────────
  out(
    `Mined ${records.length} owned, extractor-backed file(s) across ${coverage.length} language ` +
      `${coverage.length === 1 ? 'stratum' : 'strata'} (${coverage.join(', ') || 'none'}).`,
  );
  out(
    `Thresholds — min cluster ${MIN_CLUSTER_SIZE}, linkage diameter ${LINKAGE_CUTOFF}, ` +
      `tight median ${TIGHTNESS_MEDIAN_MAX} (robust MAD units), broad-ancestor cutoff ${BROAD_ANCESTOR_MAX_FILES} files.`,
  );
  out('');
  out(`Candidate families (${families.length}):`);
  if (families.length === 0) {
    out('  (none — no tight, law-less, fittable cluster in the mined universe)');
  } else {
    for (const f of families) {
      const pred =
        f.fittedPredicate.kind === 'glob'
          ? `glob ${f.fittedPredicate.value}`
          : `regex /${f.fittedPredicate.value}/`;
      out(
        `  ${f.id} — ${f.evidence.clusterSize} ${f.language} files, tightness ${f.evidence.tightness}; ` +
          `fitted ${pred}`,
      );
      for (const m of f.members) out(`      ${m}`);
    }
  }
  out('');
  out(written ? `Wrote ${written}` : `(could not write ${OUTPUT_BASENAME} — best-effort telemetry, ignored)`);

  // ── Honesty footer ─────────────────────────────────────────────────────────
  out('');
  out('— honesty labels —');
  out('PROPOSAL STREAM, never a gate: this output never affects any exit code, verdict, issue,');
  out('  or suggestedNext, and it NEVER creates or writes an aspect. A human decides.');
  out('OVERCOUNTS: structural sameness is not intent — some tight, law-less clusters are a');
  out('  coincidence of shape, not a real convention worth a rule.');
  out('UNDERCOUNTS: a real family whose members are structurally varied, span languages, or');
  out('  already share ANY narrow aspect is deliberately NOT surfaced here.');
  out(CAVEAT);
}

main();
