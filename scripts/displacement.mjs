#!/usr/bin/env node
// displacement (analysis d) — DOGFOOD calibration instrument. Read-only over git
// history + the verdict telemetry (local sidecar UNION the committed LLM stream —
// see EVENTS_PATHS). NEVER writes the lock, the events sidecar, or any graph
// file. Makes ZERO reviewer/LLM calls. No deps.
//
// WHAT: the Bode "waterbed" analysis (§6.5.3d / §7). After a rule's source is
// SHARPENED (a commit editing a content.md or check.mjs under .yggdrasil/aspects/),
// it measures the refusal-event rate of that rule's SIBLINGS in a window before vs
// after the edit, and reports the per-sibling delta. The question it answers: when
// one rule is tightened, does the pressure re-appear elsewhere (agents satisfy the
// pressed rule but trip a neighbor — Goodhart / effort-budget displacement), or does
// the whole violation vector genuinely fall?
//
// SIBLING DEFINITION (documented choice): two aspects are SIBLINGS if they share a
// verification SUBJECT — there exists a unit (node or file) on which BOTH produced
// fill events. This is the empirical projection of "same parent node" onto the units
// actually verified: siblings are the aspects that co-apply on the same subject, read
// straight from telemetry rather than re-derived from the 7-channel cascade (which
// this standalone script deliberately does not reimplement). Parent-node siblings are
// the cleaner displacement signal than architecture-type siblings, so this is the one
// chosen.
//
// WHY ABSENCE IS AS PUBLISHABLE AS PRESENCE (§7): there is NO conservation law forcing
// enforcement to be zero-sum — the waterbed can genuinely dry out because agents write
// better code. So a FLAT sibling vector after a sharpening is a real, reassuring result
// (enforcement reduced rather than displaced), reported as prominently as any rise.
// The waterbed is a PATTERN OF ANALYSIS here, not a theorem.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const out = (m = '') => process.stdout.write(m + '\n');

// Window half-width, in days, on each side of a rule edit. Tunable via env.
const WINDOW_DAYS = Number(process.env.YG_DISPLACEMENT_WINDOW_DAYS || 14);
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const ROOT = repoRoot();
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
// The fill stream has TWO possible homes and a rotation. Under
// `events.committed_llm: true` an LLM fill event goes to the COMMITTED stream and
// NOT the local sidecar (single-home, no double-count), so a local-only read stops
// dead the moment that flag was flipped — fatal for THIS analysis in particular,
// whose whole subject is the window FOLLOWING a rule edit. Mirror the CLI's own
// reader: union(local rotated, local current, committed), deduped by FULL LINE.
const EVENTS_PATHS = [
  path.join(ROOT, '.yggdrasil', '.yg-events.jsonl.1'),
  path.join(ROOT, '.yggdrasil', '.yg-events.jsonl'),
  path.join(ROOT, '.yggdrasil', 'yg-events.llm.jsonl'),
];

function isTracked(absPath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', absPath], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Union reader over every home of the fill stream. Dedupe is by FULL LINE before
 *  parsing — a git `merge=union` on the committed stream can leave byte-identical
 *  duplicates, and counting one twice would inflate a window's refusal count. */
function readEventsUnion(absPaths) {
  const seen = new Set();
  const lines = [];
  const present = [];
  const absent = [];
  for (const absPath of absPaths) {
    let raw;
    try {
      raw = readFileSync(absPath, 'utf-8');
    } catch {
      absent.push(absPath);
      continue;
    }
    present.push(absPath);
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      try {
        lines.push(JSON.parse(t));
      } catch {
        /* skip garbage line, never crash */
      }
    }
  }
  return { missing: present.length === 0, lines, present, absent };
}

// ---- fill telemetry: per-aspect trials + co-application (sibling) map ------------
const eventsFile = readEventsUnion(EVENTS_PATHS);
const perAspect = new Map(); // aspectId -> [{tsMs, x}]
const aspectsOnUnit = new Map(); // unitKey -> Set(aspectId)
let firstTs = null;
let fillTrials = 0;
for (const e of eventsFile.lines) {
  if (!e || typeof e !== 'object') continue;
  if (e.source !== 'fill') continue; // §5.2 — MUST filter by source
  if (typeof e.ts === 'string' && (firstTs === null || e.ts < firstTs)) firstTs = e.ts;
  const isRefused = e.disposition === 'refused';
  const isApproved = e.disposition === 'approved';
  if (!isRefused && !isApproved) continue; // unknown ≠ zero — exclude no-write dispositions
  const tsMs = new Date(e.ts).getTime();
  if (Number.isNaN(tsMs)) continue;
  fillTrials++;
  let arr = perAspect.get(e.aspectId);
  if (!arr) {
    arr = [];
    perAspect.set(e.aspectId, arr);
  }
  arr.push({ tsMs, x: isRefused ? 1 : 0 });
  let set = aspectsOnUnit.get(e.unitKey);
  if (!set) {
    set = new Set();
    aspectsOnUnit.set(e.unitKey, set);
  }
  set.add(e.aspectId);
}

// siblings(A) = every other aspect that shared a subject unit with A in fill telemetry.
function siblingsOf(aspectId) {
  const sibs = new Set();
  for (const set of aspectsOnUnit.values()) {
    if (!set.has(aspectId)) continue;
    for (const other of set) if (other !== aspectId) sibs.add(other);
  }
  return sibs;
}

// ---- git: rule-source edits (aspectId, editTs) ----------------------------------
function ruleEdits() {
  const SENT = '__RE__';
  const raw = git([
    'log',
    '--reverse',
    `--format=${SENT}%H|%cI`,
    '--name-only',
    '--diff-filter=AMR',
    '--',
    ':(glob).yggdrasil/aspects/**/content.md',
    ':(glob).yggdrasil/aspects/**/check.mjs',
  ]);
  const edits = [];
  let cur = null;
  const header = new RegExp('^' + SENT + '([0-9a-f]{7,40})\\|(.+)$');
  for (const line of raw.split('\n')) {
    const m = line.match(header);
    if (m) {
      cur = { sha: m[1], ts: m[2], tsMs: new Date(m[2]).getTime(), ids: new Set() };
      edits.push(cur);
    } else if (cur && line.trim()) {
      const mm = line.trim().match(/^\.yggdrasil\/aspects\/([^/]+)\/(content\.md|check\.mjs)$/);
      if (mm) cur.ids.add(mm[1]);
    }
  }
  // Flatten to one (aspectId, editTs) row per edited aspect per commit.
  const rows = [];
  for (const c of edits) for (const id of c.ids) rows.push({ aspectId: id, ts: c.ts, tsMs: c.tsMs });
  return rows;
}

// Refusal count / decided count for an aspect's trials inside [lo, hi).
function rateIn(aspectId, lo, hi) {
  const arr = perAspect.get(aspectId) || [];
  let refused = 0;
  let n = 0;
  for (const t of arr) {
    if (t.tsMs >= lo && t.tsMs < hi) {
      n++;
      if (t.x) refused++;
    }
  }
  return { refused, n };
}

const edits = ruleEdits();

out('displacement (d) — Bode "waterbed" analysis: does sharpening one rule shift pressure to its siblings?');
out(`  Window: +/- ${WINDOW_DAYS} day(s) around each rule-source edit (env YG_DISPLACEMENT_WINDOW_DAYS).`);
out('  Sibling = an aspect sharing a verification subject (same node/file) in fill telemetry.');
out('');

if (fillTrials === 0) {
  out('No fill telemetry yet — nothing to measure sibling refusal rates against.');
  out('  Run: yg check --approve  (each filled pair appends one trial).');
} else if (edits.length === 0) {
  out('No rule-source edits (content.md / check.mjs) in the visible git history — nothing to analyze.');
} else {
  const EPS = 1e-9;
  let editsWithComparison = 0; // >=1 sibling with BOTH windows decided
  let roseCount = 0; // sibling refusal-rate RISES — the only shape that is displacement
  let fellCount = 0; // FALLS — the opposite of displacement (reassuring)
  let maxRise = 0;
  for (const edit of edits) {
    const lo = edit.tsMs - WINDOW_MS;
    const hi = edit.tsMs + WINDOW_MS;
    const sibs = [...siblingsOf(edit.aspectId)].sort();
    const signal = []; // computable AND a refusal appears in either window
    let flat = 0; // computable, 0 refusals both windows
    let insufficient = 0; // exactly one window has decided trials
    for (const sib of sibs) {
      const before = rateIn(sib, lo, edit.tsMs);
      const after = rateIn(sib, edit.tsMs, hi);
      const bothDecided = before.n > 0 && after.n > 0;
      if (!bothDecided) {
        if (before.n > 0 || after.n > 0) insufficient++; // one side known — a real comparison is impossible
        continue; // (before.n===0 && after.n===0) → no activity at all, silently skipped
      }
      if (before.refused === 0 && after.refused === 0) {
        flat++;
        continue;
      }
      const delta = after.refused / after.n - before.refused / before.n;
      if (delta > EPS) {
        roseCount++;
        maxRise = Math.max(maxRise, delta);
      } else if (delta < -EPS) fellCount++;
      signal.push({ sib, before, after, delta });
    }
    // Only edits that admit a genuine before/after comparison are reported.
    if (signal.length === 0 && flat === 0) continue;
    editsWithComparison++;
    out(`Rule edit: ${edit.aspectId} content/check sharpened at ${edit.ts}`);
    if (signal.length > 0) {
      out('  sibling                              before(refused/N)   after(refused/N)   delta   shape');
      for (const r of signal) {
        const bStr = `${r.before.refused}/${r.before.n}`;
        const aStr = `${r.after.refused}/${r.after.n}`;
        const dStr = (r.delta >= 0 ? '+' : '') + (Math.round(r.delta * 1000) / 1000).toFixed(3);
        const shape = r.delta > EPS ? 'ROSE (candidate displacement)' : r.delta < -EPS ? 'fell (anti-displacement)' : 'flat';
        out(`  ${r.sib.padEnd(36)} ${bStr.padStart(15)}   ${aStr.padStart(15)}   ${dStr.padStart(6)}   ${shape}`);
      }
    }
    const tail = [];
    if (flat > 0) tail.push(`${flat} sibling(s) flat (0 refusals in both windows)`);
    if (insufficient > 0) tail.push(`${insufficient} sibling(s) insufficient (one window empty — unknown ≠ zero)`);
    if (tail.length > 0) out(`  ${tail.join('; ')}`);
    out('');
  }

  out(`Summary: ${edits.length} rule-source edit(s) examined; ${editsWithComparison} admitted a before/after sibling comparison; ${roseCount} sibling refusal-rate RISE(s), ${fellCount} FALL(s).`);
  if (editsWithComparison === 0) {
    out('No computable sibling comparison in range — every candidate sibling lacked a before- or after-window');
    out('  in the local telemetry (fills are too clustered in time). Not evidence of absence (unknown ≠ zero).');
  } else if (roseCount === 0) {
    out('No displacement observed — NO sibling\'s refusal rate rose after any sharpening.');
    out('  This is a PUBLISHABLE result (§7): a flat/falling sibling vector is evidence enforcement REDUCED');
    out('  pressure rather than displacing it. There is no conservation law forcing the waterbed to bulge');
    out(`  elsewhere — the ${fellCount} fall(s) are the opposite of displacement.`);
  } else {
    out(`${roseCount} sibling refusal-rate rise(s) observed (largest +${(Math.round(maxRise * 1000) / 1000).toFixed(3)}) — candidate displacement.`);
    out('  A rise MAY be displacement (Goodhart / effort-budget) OR ordinary code churn in the same window —');
    out('  a rule edit invalidates only its OWN pairs, so any sibling movement is confounded. Correlation in');
    out('  a thin window is not causation; the ABSENCE of a rise is equally publishable (§7).');
  }
}

// ---- Honesty footer -------------------------------------------------------------
out('');
out('— honesty labels —');
const LOCAL_SIDECAR = path.join(ROOT, '.yggdrasil', '.yg-events.jsonl');
const COMMITTED_STREAM = path.join(ROOT, '.yggdrasil', 'yg-events.llm.jsonl');
const rels = (ps) => ps.map((p) => path.relative(ROOT, p)).join(', ');
if (eventsFile.missing) {
  out(`  no fill telemetry recorded yet — none of ${rels(EVENTS_PATHS)} exists (unknown ≠ zero: an absent file is not a measurement of zero).`);
} else {
  out(`  read as a union of ${rels(eventsFile.present)}, deduped by full line; first trial observed ${firstTs ?? '(none)'}.`);
  if (eventsFile.absent.length > 0) {
    out(`  absent (contributed nothing): ${rels(eventsFile.absent)}.`);
  }
  if (eventsFile.present.includes(COMMITTED_STREAM)) {
    out('  committed-stream mix — part of this series comes from the SHARED, team-committed LLM-fill stream, so a window can span machines and judge regimes rather than one machine; machines on older CLIs wrote only locally and do not contribute, so the shared part is never assumed complete.');
  }
  if (isTracked(LOCAL_SIDECAR)) {
    out(`  ${path.relative(ROOT, LOCAL_SIDECAR)}: local-telemetry label REFUSED — the LOCAL sidecar is TRACKED in git, which it must never be. It can be hand-edited and mixes machines; treat the figures above as untrusted until it is gitignored again. (The committed LLM stream being tracked is by design and is not this problem.)`);
  }
}
out(`  small-N — a +/- ${WINDOW_DAYS}-day window over rare refusals yields tiny per-sibling counts; a delta of 1/8 vs 0/6 is indicative, not significant.`);
out('  unknown ≠ zero — a sibling with no decided trial in a window is UNKNOWN (rendered "insufficient"), never scored as a 0% refusal rate; a rule edit invalidates only its OWN pairs, so sibling movement is confounded by ordinary code churn.');

process.exit(0);
