#!/usr/bin/env node
// judge-stability (analysis a) — DOGFOOD calibration instrument. Read-only over
// LOCAL telemetry. NEVER writes the lock, the events sidecar, the drill-results
// sidecar, or any graph file. Makes ZERO reviewer/LLM calls. No deps.
//
// WHAT: measures the reviewer's SELF-CONSISTENCY — how often a judge disagrees
// with ITSELF when handed the exact same input twice. It reads two append-only
// local telemetry sidecars under .yggdrasil/:
//   * .yg-events.jsonl  — filtered to source:'diag' (yg aspect-test --repeat / --tier
//     runs), the LLM lines only. Repeat runs on one (aspectId, unitKey) share an
//     input hash; identical hash = identical input.
//   * .drill-results.jsonl — the LLM lines only. Repeated drill runs of one
//     (aspect, case) share a caseHash + ruleHash; identical pair = identical input.
// It groups each source by its identical-input key, and for a group of N runs
// counts the MINORITY split k — the number of runs that landed on the losing
// verdict. k/N > 0 means the reviewer contradicted itself on unchanged input.
//
// WHY: a persistent k/N split on identical input is MEASURED RULE AMBIGUITY, not
// reviewer error and not code correctness — the rule text (content.md) admits two
// readings and the judge picks between them at random. That is the signal that a
// rule should be SHARPENED: the fix is to tighten content.md so the reading is
// forced, which is exactly the §6.3a nomination this instrument raises. Consistency
// (k=0 across every group) is itself a publishable result — it says the rule set is
// unambiguous at the current judge, and it is the healthy default this repo shows.
//
// HONESTY: deterministic checks are consistent BY CONSTRUCTION, so they are excluded
// from the ambiguity measure (a deterministic split would be a check BUG, surfaced
// separately, not rule ambiguity). Every figure is small-N at this repo's scale;
// absence of a diagnostic-repeat corpus is UNKNOWN, never a certificate of stability.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const out = (m = '') => process.stdout.write(m + '\n');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const ROOT = repoRoot();
const YG = path.join(ROOT, '.yggdrasil');
const EVENTS_PATH = path.join(YG, '.yg-events.jsonl');
const DRILL_PATH = path.join(YG, '.drill-results.jsonl');

// A telemetry file that is TRACKED in git is no longer local/private telemetry —
// it mixes machines and judge regimes and can be hand-edited. The honesty footer
// REFUSES the "local telemetry since" label for any tracked source.
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

// Parse a JSONL sidecar. Missing file ⇒ {missing:true, lines:[]} (honest empty, not a
// crash). A garbage line is skipped, not fatal.
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
      /* skip an unparseable line — never crash on garbage telemetry */
    }
  }
  return { missing: false, lines };
}

const eventsFile = readJsonl(EVENTS_PATH);
const drillFile = readJsonl(DRILL_PATH);

// Track the earliest timestamp actually observed, for the "local telemetry since" label.
let firstTs = null;
const noteTs = (ts) => {
  if (typeof ts === 'string' && ts && (firstTs === null || ts < firstTs)) firstTs = ts;
};

// ---- Group builder: key -> array of verdict tokens ('refused' | other) ----------
// We reduce each verdict to a binary token so the minority split is well-defined
// regardless of the source's vocabulary (events use approved/refused; drills use
// satisfied/refused). Non-decisions (infra, unrun, unsupported) are dropped — an
// UNKNOWN is not a vote (unknown ≠ zero).
function addGroup(map, key, token, aspectId, unit) {
  let g = map.get(key);
  if (!g) {
    g = { aspectId, unit, tokens: [] };
    map.set(key, g);
  }
  g.tokens.push(token);
}

// Source 1: diagnostic repeat runs from the events sidecar (source:'diag', LLM).
const diagGroups = new Map();
let diagLines = 0;
for (const e of eventsFile.lines) {
  if (!e || typeof e !== 'object') continue;
  noteTs(e.ts);
  if (e.source !== 'diag') continue; // §5.2 — MUST filter by source; mixing regimes is corruption
  if (e.kind !== 'llm') continue; // deterministic is consistent by construction
  if (e.disposition !== 'approved' && e.disposition !== 'refused') continue; // drop no-write unknowns
  if (typeof e.hash !== 'string') continue; // identical-input needs a hash to group on
  diagLines++;
  const key = `${e.aspectId}\0${e.unitKey}\0${e.hash}`;
  addGroup(diagGroups, key, e.disposition === 'refused' ? 'refused' : 'other', e.aspectId, e.unitKey);
}

// Source 2: repeated drill runs (LLM only) — identical input = same caseHash+ruleHash.
const drillGroups = new Map();
let drillLlmLines = 0;
let detGroupsChecked = 0;
let detSplits = 0;
const detGroups = new Map();
for (const d of drillFile.lines) {
  if (!d || typeof d !== 'object') continue;
  noteTs(d.ts);
  if (d.got !== 'refused' && d.got !== 'satisfied') continue; // drop unrun/unsupported unknowns
  const key = `${d.aspect}\0${d.case}\0${d.caseHash}\0${d.ruleHash}`;
  const token = d.got === 'refused' ? 'refused' : 'other';
  if (d.kind === 'llm') {
    drillLlmLines++;
    addGroup(drillGroups, key, token, d.aspect, d.case);
  } else if (d.kind === 'deterministic') {
    // Sanity channel only: deterministic checks MUST be consistent; a split here is a
    // non-determinism bug in the check, not rule ambiguity.
    addGroup(detGroups, key, token, d.aspect, d.case);
  }
}

// Minority split k of a token array over decided votes.
function split(tokens) {
  const refused = tokens.filter((t) => t === 'refused').length;
  const other = tokens.length - refused;
  return { k: Math.min(refused, other), n: tokens.length, refused, other };
}

// Collect the multi-run groups (N>=2) that actually disagree (k>0), plus totals.
function harvest(map) {
  const disagreements = [];
  let multiRunGroups = 0;
  for (const g of map.values()) {
    if (g.tokens.length < 2) continue;
    multiRunGroups++;
    const s = split(g.tokens);
    if (s.k > 0) disagreements.push({ aspectId: g.aspectId, unit: g.unit, ...s });
  }
  disagreements.sort((a, b) => b.k / b.n - a.k / a.n);
  return { disagreements, multiRunGroups };
}

const diag = harvest(diagGroups);
const drill = harvest(drillGroups);
for (const g of detGroups.values()) {
  if (g.tokens.length < 2) continue;
  detGroupsChecked++;
  if (split(g.tokens).k > 0) detSplits++;
}

// ---- Report ---------------------------------------------------------------------
out('judge-stability (a) — reviewer self-consistency on IDENTICAL input');
out('  A k/N split = the reviewer disagreed with ITSELF on unchanged input:');
out('  measured rule ambiguity (content.md admits two readings), not correctness.');
out('');

const anyMultiRun = diag.multiRunGroups + drill.multiRunGroups > 0;

if (!anyMultiRun) {
  out('No reviewer self-consistency telemetry yet.');
  out(`  diagnostic (aspect-test --repeat / --tier) LLM lines: ${diagLines} (need >=2 on one`);
  out('    identical-input key to measure a split; run: yg aspect-test --aspect <id> --node <path> --repeat N)');
  out(`  drill LLM lines: ${drillLlmLines} (need a case run more than once to measure a split)`);
} else {
  // Diagnostic-source splits.
  out(`Diagnostic repeat runs (aspect-test): ${diag.multiRunGroups} identical-input group(s) with N>=2.`);
  if (diag.disagreements.length === 0) {
    out('  No self-disagreement — every repeated diagnostic run reproduced its verdict.');
  } else {
    for (const d of diag.disagreements) {
      out(`  ${d.aspectId}: ${d.unit} split ${d.k}/${d.n} — the reviewer disagreed with itself on identical input (measured rule ambiguity, not correctness)`);
      out(`    -> nominate: sharpen ${d.aspectId} content.md — a persistent split on unchanged input is the §6.3a signal to force the reading (run: yg impact --aspect ${d.aspectId} first)`);
    }
  }
  out('');
  // Drill-source splits.
  out(`Repeated drill cases (LLM): ${drill.multiRunGroups} identical-input group(s) with N>=2.`);
  if (drill.disagreements.length === 0) {
    out('  No self-disagreement — every repeated LLM drill case reproduced its verdict.');
  } else {
    for (const d of drill.disagreements) {
      out(`  ${d.aspectId}: ${d.unit} split ${d.k}/${d.n} — the reviewer disagreed with itself on identical drill input (measured rule ambiguity, not correctness)`);
      out(`    -> nominate: sharpen ${d.aspectId} content.md — a persistent split is the §6.3a signal to force the reading (run: yg impact --aspect ${d.aspectId} first)`);
    }
  }
}

out('');
out(`Deterministic sanity channel: ${detGroupsChecked} repeated deterministic drill group(s) checked, ${detSplits} split(s).`);
out('  (A deterministic split would be a non-determinism BUG in the check, not rule ambiguity — expected: 0.)');

// ---- Honesty footer -------------------------------------------------------------
out('');
out('— honesty labels —');
for (const [p, f] of [
  [EVENTS_PATH, eventsFile],
  [DRILL_PATH, drillFile],
]) {
  const rel = path.relative(ROOT, p);
  if (f.missing) {
    out(`  ${rel}: absent — no telemetry recorded yet (unknown ≠ zero: an absent file is not a measurement of zero).`);
  } else if (isTracked(p)) {
    out(`  ${rel}: local-telemetry label REFUSED — this file is TRACKED in git. Committed telemetry is not local/private, mixes machines and judge regimes, and can be hand-edited; treat the figures above as untrusted until it is gitignored again.`);
  } else {
    out(`  local telemetry since ${firstTs ?? '(none observed)'} — ${rel} (append-only, gitignored, this machine only).`);
  }
}
out('  small-N — at this repo\'s scale every split is indicative, not significant; one flaky run out of a handful is noise, not a measured ambiguity rate.');
out('  unknown ≠ zero — no-write dispositions (infra), unrun/unsupported drills, and the total ABSENCE of a diagnostic-repeat corpus are UNKNOWNS excluded above, never counted as consistency.');
