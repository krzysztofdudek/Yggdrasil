#!/usr/bin/env node
// mcnemar (analysis c) — DOGFOOD calibration instrument. Read-only over LOCAL
// telemetry. NEVER writes the lock, the drill-results sidecar, or any graph file.
// Makes ZERO reviewer/LLM calls. No deps.
//
// WHAT: a paired old-vs-new reviewer comparison — McNemar's test — over the drill
// corpus. It reads .yggdrasil/.drill-results.jsonl (LLM lines only), keeps the two
// tiers named on the command line, pairs by (aspect, case) — the SAME drill case run
// under both tiers — and builds the 2x2 discordance table:
//     b = old refused, new satisfied   (a violation the OLD reviewer caught, the NEW missed)
//     c = old satisfied, new refused    (the reverse)
// It reports McNemar's statistic on the discordant pairs (b, c): the exact two-sided
// binomial p-value when b+c is small, else the continuity-corrected chi-square form —
// stated in plain words, not just a number.
//
// WHY (the model-swap protocol, §6.5.3c): a verdict does NOT auto-invalidate when a
// tier is re-pointed to a new model version — tier re-pointing is deliberately
// INVISIBLE to the lock (an L1 property), so a model swap silently changes the judge
// while every cached green verdict stays green. The ONLY honest before/after is a
// PAIRED comparison on the SAME cases under both judges. McNemar is the right test
// because it conditions on the discordant pairs only — the cases where the two
// reviewers actually disagree — and ignores the cases they both call the same way,
// which carry no information about a difference. See docs/model-swap-protocol.md.
//
// USAGE: node scripts/mcnemar.mjs --old <tierA> --new <tierB>
//   With one or neither tier present in the data, it reports "need two tiers to
//   compare" and exits 0 (an honest empty result, never a crash).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const out = (m = '') => process.stdout.write(m + '\n');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const ROOT = repoRoot();
const DRILL_PATH = path.join(ROOT, '.yggdrasil', '.drill-results.jsonl');

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

function readJsonl(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch {
    return { missing: true, lines: [] };
  }
  const lines = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t));
    } catch {
      /* skip garbage line, never crash */
    }
  }
  return { missing: false, lines };
}

// ---- CLI args -------------------------------------------------------------------
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const oldTier = argValue('--old');
const newTier = argValue('--new');

// ---- statistics helpers ---------------------------------------------------------
// Binomial coefficient C(n, k) — n is small here (exact path only for b+c < 25).
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
// Exact two-sided binomial p-value for McNemar with p=0.5.
function exactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= lo; i++) tail += choose(n, i) * Math.pow(0.5, n);
  return Math.min(1, 2 * tail);
}
// erfc via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7) — no deps.
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const tau =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? tau : 2 - tau;
}
// Chi-square (1 df) survival function: p = erfc(sqrt(chi2/2)).
function chiSquare1dfP(chi2) {
  return erfc(Math.sqrt(chi2 / 2));
}

// ---- load & pair ----------------------------------------------------------------
const drillFile = readJsonl(DRILL_PATH);

// Latest decided got per (aspect, case, tier). Latest by ts wins (a case re-run under
// the same tier keeps the most recent verdict).
const latest = new Map(); // `${aspect}\0${case}\0${tier}` -> {ts, got}
let firstTs = null;
const tiersSeen = new Set();
for (const d of drillFile.lines) {
  if (!d || typeof d !== 'object') continue;
  if (d.kind !== 'llm') continue; // tiers are an LLM concept
  if (typeof d.ts === 'string' && (firstTs === null || d.ts < firstTs)) firstTs = d.ts;
  if (typeof d.tier === 'string') tiersSeen.add(d.tier);
  if (d.got !== 'refused' && d.got !== 'satisfied') continue; // drop unrun/unsupported unknowns
  const key = `${d.aspect}\0${d.case}\0${d.tier}`;
  const prev = latest.get(key);
  if (!prev || d.ts > prev.ts) latest.set(key, { ts: d.ts, got: d.got });
}

out('mcnemar (c) — paired old-vs-new reviewer comparison over the drill corpus');
out('  The honest before/after for a model swap: a verdict does NOT auto-invalidate');
out('  when a tier is re-pointed, so only a PAIRED comparison on the same cases counts.');
out('');

if (!oldTier || !newTier) {
  out('Usage: node scripts/mcnemar.mjs --old <tierA> --new <tierB>');
  out(`  Tiers present in the drill telemetry: ${[...tiersSeen].sort().join(', ') || '(none)'}`);
  out('  Provide two tiers to compare. See docs/model-swap-protocol.md for the full procedure.');
} else {
  // Pull the paired verdicts by (aspect, case) present under BOTH tiers.
  const byCase = new Map(); // `${aspect}\0${case}` -> {old, new}
  for (const [key, val] of latest) {
    const [aspect, caseId, tier] = key.split('\0');
    if (tier !== oldTier && tier !== newTier) continue;
    const ck = `${aspect}\0${caseId}`;
    let rec = byCase.get(ck);
    if (!rec) {
      rec = {};
      byCase.set(ck, rec);
    }
    if (tier === oldTier) rec.old = val.got;
    if (tier === newTier) rec.new = val.got;
  }

  let a = 0; // both refused
  let dd = 0; // both satisfied
  let b = 0; // old refused, new satisfied — old caught, new missed
  let c = 0; // old satisfied, new refused — old missed, new caught
  let paired = 0;
  for (const rec of byCase.values()) {
    if (rec.old == null || rec.new == null) continue; // not present under BOTH tiers
    paired++;
    if (rec.old === 'refused' && rec.new === 'refused') a++;
    else if (rec.old === 'satisfied' && rec.new === 'satisfied') dd++;
    else if (rec.old === 'refused' && rec.new === 'satisfied') b++;
    else if (rec.old === 'satisfied' && rec.new === 'refused') c++;
  }

  if (paired === 0) {
    out(`Need two tiers to compare — no (aspect, case) was run under BOTH '${oldTier}' and '${newTier}'.`);
    out(`  Tiers present in the drill telemetry: ${[...tiersSeen].sort().join(', ') || '(none)'}`);
    out('  Run the drill corpus under each candidate tier before comparing (see docs/model-swap-protocol.md).');
  } else {
    const n = b + c;
    out(`Paired cases (run under both '${oldTier}' and '${newTier}'): ${paired}`);
    out('  2x2 discordance table:');
    out(`    both refused (concordant)   a = ${a}`);
    out(`    both satisfied (concordant) d = ${dd}`);
    out(`    old refused / new satisfied b = ${b}   (old caught, new missed)`);
    out(`    old satisfied / new refused c = ${c}   (old missed, new caught)`);
    out('');
    if (n === 0) {
      out('No discordant pairs — the two reviewers agreed on every paired case.');
      out(`  0 cases the old reviewer caught and the new missed; 0 the reverse; no measurable difference (nothing to distinguish).`);
    } else {
      let p;
      let method;
      if (n < 25) {
        p = exactP(b, c);
        method = 'exact two-sided binomial';
      } else {
        const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / n; // continuity-corrected
        p = chiSquare1dfP(chi2);
        method = `continuity-corrected chi-square (chi2=${Math.round(chi2 * 100) / 100}, 1 df)`;
      }
      const pStr = p < 0.0001 ? '<0.0001' : String(Math.round(p * 10000) / 10000);
      const verdict =
        p < 0.05
          ? `the difference is statistically significant (p=${pStr}, ${method}) — the reviewers are NOT interchangeable on this corpus`
          : `not statistically distinguishable at the paired level (p=${pStr}, ${method}) — no evidence the swap changed behavior on this corpus`;
      out(`${b} cases the old reviewer caught and the new missed; ${c} the reverse; ${verdict}.`);
    }
  }
}

// ---- Honesty footer -------------------------------------------------------------
out('');
out('— honesty labels —');
const rel = path.relative(ROOT, DRILL_PATH);
if (drillFile.missing) {
  out(`  ${rel}: absent — no drill telemetry recorded yet (unknown ≠ zero: an absent file is not a measurement of zero).`);
} else if (isTracked(DRILL_PATH)) {
  out(`  ${rel}: local-telemetry label REFUSED — this file is TRACKED in git. Committed telemetry is not local/private, mixes machines and judge regimes, and can be hand-edited; treat the figures above as untrusted until it is gitignored again.`);
} else {
  out(`  local telemetry since ${firstTs ?? '(none observed)'} — ${rel} (append-only, gitignored, this machine only).`);
}
out('  small-N — McNemar over a handful of discordant pairs is indicative, not significant; the exact binomial path is used precisely because b+c is small here.');
out('  unknown ≠ zero — unrun/unsupported drill cases and any case missing under either tier are EXCLUDED from the pairing, never scored as agreement.');

process.exit(0);
