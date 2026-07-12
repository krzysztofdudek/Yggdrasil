#!/usr/bin/env node
// cusum (analysis b) — DOGFOOD calibration instrument. Read-only over LOCAL
// telemetry. NEVER writes the lock, the events sidecar, or any graph file. Makes
// ZERO reviewer/LLM calls. No deps.
//
// WHAT: a one-sided Bernoulli CUSUM per aspect over the fill telemetry. It reads
// .yggdrasil/.yg-events.jsonl filtered to source:'fill' (the yg check --approve
// stream), treats disposition:'refused' as 1 and 'approved' as 0, EXCLUDES every
// no-write disposition (infra and other runtime failures — they are not an
// approve/refuse Bernoulli trial), orders each aspect's trials by timestamp, and
// accumulates the sequential-probability-ratio CUSUM statistic. When the statistic
// crosses a documented decision interval it raises a plain-language alarm naming the
// aspect, the approximate time, and how many refusal signals drove the excursion.
//
// WHY NOT A P-CHART: refusals are RARE (this repo: a single-digit count over
// thousands of fills). A Shewhart p-chart needs a stable, non-tiny p per subgroup
// and reacts only to a single wild point; a CUSUM ACCUMULATES small persistent
// deviations and is the correct tool for detecting a sustained upward shift in a
// rare-event rate (§6.5.3b). An isolated refusal is expected noise and must NOT
// alarm; a CLUSTER of refusals where the baseline predicts near-zero is the signal.
//
// METHOD (documented, tunable): in-control refusal rate p0 = the pooled refusal rate
// across ALL fill trials, floored at P0_FLOOR so a near-zero pooled rate does not
// blow up the log-likelihood. Out-of-control rate p1 = SHIFT_MULT x p0 (floored at
// P1_FLOOR) — the elevated rate we want to catch. Each trial x contributes the
// log-likelihood-ratio weight ln(p1/p0) on a refusal, ln((1-p1)/(1-p0)) on an
// approval; S = max(0, S + w); an alarm fires when S >= H and S resets to 0 to look
// for the next distinct shift. Larger H = fewer false alarms but slower detection.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const out = (m = '') => process.stdout.write(m + '\n');

// ---- tunable, documented control-chart parameters -------------------------------
const P0_FLOOR = 0.01; // in-control refusal rate is floored here (1%) — avoids ln blow-up on a near-zero pooled rate
const SHIFT_MULT = 5; // out-of-control rate = 5x the in-control rate
const P1_FLOOR = 0.05; // ...but at least 5%
const H = 4.0; // decision interval — S must reach this to alarm (~3 clustered refusals at these rates)

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const ROOT = repoRoot();
const EVENTS_PATH = path.join(ROOT, '.yggdrasil', '.yg-events.jsonl');

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

const eventsFile = readJsonl(EVENTS_PATH);

// Collect fill trials per aspect. A trial is an approve/refuse Bernoulli outcome;
// every no-write disposition is EXCLUDED (unknown ≠ zero — infra is not an approval).
const perAspect = new Map(); // aspectId -> [{ts, x}]
let firstTs = null;
let totalTrials = 0;
let totalRefusals = 0;
let excludedNoWrite = 0;
for (const e of eventsFile.lines) {
  if (!e || typeof e !== 'object') continue;
  if (e.source !== 'fill') continue; // §5.2 — MUST filter by source
  if (typeof e.ts === 'string' && (firstTs === null || e.ts < firstTs)) firstTs = e.ts;
  const isRefused = e.disposition === 'refused';
  const isApproved = e.disposition === 'approved';
  if (!isRefused && !isApproved) {
    excludedNoWrite++;
    continue;
  }
  const x = isRefused ? 1 : 0;
  totalTrials++;
  if (isRefused) totalRefusals++;
  let arr = perAspect.get(e.aspectId);
  if (!arr) {
    arr = [];
    perAspect.set(e.aspectId, arr);
  }
  arr.push({ ts: e.ts, x });
}

out('cusum (b) — per-aspect Bernoulli CUSUM over the fill stream (rare-event shift detector)');
out('  Detects a SUSTAINED upward shift in an aspect\'s refusal rate — not a single');
out('  refusal (expected noise), but a cluster the baseline says should be near-zero.');
out('');

if (totalTrials === 0) {
  out('No fill telemetry yet — no approve/refuse trials recorded.');
  out('  Run: yg check --approve  (each filled (aspect, unit) pair appends one trial).');
} else {
  const p0 = Math.max(totalRefusals / totalTrials, P0_FLOOR);
  const p1 = Math.min(0.5, Math.max(p0 * SHIFT_MULT, P1_FLOOR));
  const wRef = Math.log(p1 / p0);
  const wApp = Math.log((1 - p1) / (1 - p0));
  const round = (x) => Math.round(x * 100) / 100;

  out('Control parameters (documented, tunable at the top of this script):');
  out(`  in-control refusal rate p0 = ${round(p0)} (pooled ${totalRefusals}/${totalTrials}, floored at ${P0_FLOOR})`);
  out(`  out-of-control rate      p1 = ${round(p1)} (${SHIFT_MULT}x p0, floored at ${P1_FLOOR})`);
  out(`  per-refusal weight +${round(wRef)}, per-approval weight ${round(wApp)}, decision interval H = ${H}`);
  out('');

  const alarms = [];
  const peaks = [];
  for (const [aspectId, trialsRaw] of perAspect) {
    const trials = [...trialsRaw].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let S = 0;
    let peak = 0;
    let refusalsInExcursion = 0;
    let firstExcursionTs = null;
    for (const t of trials) {
      const w = t.x ? wRef : wApp;
      if (S === 0) {
        refusalsInExcursion = 0;
        firstExcursionTs = t.ts;
      }
      S = Math.max(0, S + w);
      if (t.x) refusalsInExcursion++;
      if (S > peak) peak = S;
      if (S >= H) {
        alarms.push({
          aspectId,
          ts: t.ts,
          fromTs: firstExcursionTs,
          signals: refusalsInExcursion,
          peak: S,
        });
        S = 0; // reset to detect the next distinct shift
      }
    }
    const refusals = trials.filter((t) => t.x).length;
    peaks.push({ aspectId, peak, trials: trials.length, refusals });
  }

  if (alarms.length === 0) {
    out('No aspect crossed the alarm threshold — refusals are isolated, not sustained.');
    out('  (This is the healthy default: an occasional refusal is noise, not a rate shift.)');
  } else {
    out('ALARMS — an aspect whose refusal rate shifted upward:');
    for (const a of alarms) {
      out(`  ${a.aspectId}: refusal rate shifted upward around ${a.ts} — ${a.signals} refusal signal(s) accumulated (CUSUM S reached ${round(a.peak)} >= H ${H}, excursion began ${a.fromTs})`);
    }
  }
  out('');
  // Show the aspects that climbed closest to the threshold without alarming, for context.
  const near = peaks
    .filter((p) => p.refusals > 0)
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 5);
  if (near.length > 0) {
    out('Highest non-alarming CUSUM peaks (aspects with >=1 refusal, for context):');
    for (const p of near) {
      out(`  ${p.aspectId}: peak S ${round(p.peak)} over ${p.trials} trial(s), ${p.refusals} refusal(s)`);
    }
    out('');
  }
  const flat = peaks.filter((p) => p.refusals === 0).length;
  out(`${perAspect.size} aspect(s) tracked; ${alarms.length} alarm(s); ${flat} aspect(s) never refused; ${excludedNoWrite} no-write disposition(s) excluded.`);
}

// ---- Honesty footer -------------------------------------------------------------
out('');
out('— honesty labels —');
const rel = path.relative(ROOT, EVENTS_PATH);
if (eventsFile.missing) {
  out(`  ${rel}: absent — no fill telemetry recorded yet (unknown ≠ zero: an absent file is not a measurement of zero).`);
} else if (isTracked(EVENTS_PATH)) {
  out(`  ${rel}: local-telemetry label REFUSED — this file is TRACKED in git. Committed telemetry is not local/private, mixes machines and judge regimes, and can be hand-edited; treat the figures above as untrusted until it is gitignored again.`);
} else {
  out(`  local telemetry since ${firstTs ?? '(none observed)'} — ${rel} (append-only, gitignored, this machine only).`);
}
out('  small-N — refusals are rare; a CUSUM over a handful of them is indicative, not significant, and the alarm-rate (ARL) implied by H is order-of-magnitude at this scale.');
out('  unknown ≠ zero — infra and other no-write dispositions are EXCLUDED trials, not approvals; a quiet aspect is one not yet exercised, not one proven safe.');

process.exit(0);
