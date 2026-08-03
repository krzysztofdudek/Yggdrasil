#!/usr/bin/env node
// prompt-headroom — standing measurement, not a gate.
//
// WHAT it reports: the largest LLM reviewer prompt this repo's own graph currently
// assembles, anywhere, and how much room is left under the configured tier ceiling
// (reviewer.tiers.<name>.max_prompt_chars) before the next edit trips it.
//
// WHY it exists as its own step, separate from the "Graph: check" gate below it: that
// gate only turns red once a prompt actually BREACHES the ceiling — the first anyone
// sees of a shrinking margin is the commit that finally crosses it, with no warning on
// any of the commits that spent it down first. This step runs on every gate invocation
// and reports the margin every time, so a shrinking number is visible long before it
// reaches zero.
//
// METHOD: `yg check` recomputes every LLM pair's assembled prompt size against the
// configured ceiling as part of its own §4 gate (spec §4) — but only ever reports a
// pair that is OVER the limit; a pair comfortably under it never surfaces its char
// count. This script borrows that same gate to make EVERY pair report its count: it
// temporarily overrides the tier's max_prompt_chars to 1 char via the gitignored,
// deep-merge yg-secrets.yaml overlay (config-parser.ts's own documented seam for
// exactly this kind of local, non-committed override — the tier NAME is the only
// verdict-hash input, so this invalidates no recorded verdict), runs a plain,
// read-only `yg check` (no --approve — nothing is written), and parses every
// resulting "Assembled reviewer prompt … is N chars" line. The override is restored
// to its exact original bytes (or removed, if none existed) before this script exits,
// success or failure — a trap-style restore that never leaves the repo's real
// reviewer config altered.
//
// This measures the WHOLE graph, every LLM aspect on every subject, not one aspect in
// isolation — the tightest margin anywhere is what actually decides how much room the
// next edit has, regardless of which aspect's prompt happens to be nearest the ceiling
// today.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'source/cli/dist/bin.js');
const CONFIG_PATH = path.join(REPO_ROOT, '.yggdrasil/yg-config.yaml');
const SECRETS_PATH = path.join(REPO_ROOT, '.yggdrasil/yg-secrets.yaml');

function log(m) { process.stdout.write(`[prompt-headroom] ${m}\n`); }
function fail(m) { process.stderr.write(`[prompt-headroom] FAIL: ${m}\n`); process.exit(1); }

if (!existsSync(BIN_PATH)) fail(`built binary missing at ${BIN_PATH} — run the build step first.`);
if (!existsSync(CONFIG_PATH)) fail(`no committed config at ${CONFIG_PATH} — is this the repo root?`);

// The real, committed ceiling(s) — read straight from yg-config.yaml, never from the
// overlay this script is about to write. This repo configures one tier per name; a
// project with several would report each name's own line here.
const configText = readFileSync(CONFIG_PATH, 'utf-8');
const tierLimits = new Map();
{
  const tiersBlockMatch = configText.match(/reviewer:\s*\n\s*tiers:\s*\n([\s\S]*?)(?:\n\S|\n?$)/);
  const tiersBlock = tiersBlockMatch ? tiersBlockMatch[1] : configText;
  const tierNameRe = /^\s{4}(\S+):\s*$/gm;
  const names = [];
  let m;
  while ((m = tierNameRe.exec(tiersBlock))) names.push({ name: m[1], at: m.index });
  for (let i = 0; i < names.length; i++) {
    const start = names[i].at;
    const end = i + 1 < names.length ? names[i + 1].at : tiersBlock.length;
    const slice = tiersBlock.slice(start, end);
    const limitMatch = slice.match(/max_prompt_chars:\s*(\d+)/);
    if (limitMatch) tierLimits.set(names[i].name, Number(limitMatch[1]));
  }
}
if (tierLimits.size === 0) fail(`could not find any reviewer.tiers.<name>.max_prompt_chars in ${CONFIG_PATH} — the parser above may need updating for a config shape change.`);

// ---- Temporarily override every tier's ceiling via the gitignored overlay ----
const hadSecrets = existsSync(SECRETS_PATH);
const originalSecrets = hadSecrets ? readFileSync(SECRETS_PATH, 'utf-8') : null;
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  if (hadSecrets) writeFileSync(SECRETS_PATH, originalSecrets);
  else if (existsSync(SECRETS_PATH)) rmSync(SECRETS_PATH);
}
// Last-resort net: restore on process exit even if something below throws or calls
// process.exit() directly, so a crash never leaves the real reviewer config altered.
process.on('exit', restore);

let stdout = '';
try {
  const overlayTiers = [...tierLimits.keys()]
    .map((name) => `    ${name}:\n      max_prompt_chars: 1\n`)
    .join('');
  writeFileSync(SECRETS_PATH, `reviewer:\n  tiers:\n${overlayTiers}`);

  try {
    // --details: the ungrouped, one-block-per-issue view. Plain `yg check`'s default
    // grouped view caps how many distinct groups it prints (falling back to "run
    // --top <n> or --aspect <id>" beyond that) — with every LLM pair now tripping the
    // gate, the pair count alone spans far more groups than that cap allows, and a
    // capped view would silently under-report exactly the tail this script exists to
    // find. --details has no such cap: every pair renders its own block.
    stdout = execFileSync('node', [BIN_PATH, 'check', '--details'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // `yg check` exits 1 whenever anything is unverified/oversized — expected here
    // (every LLM pair now trips the 1-char ceiling). Its stdout is still the report.
    stdout = e.stdout ?? '';
    if (!stdout) fail(`yg check produced no output (${e.message}). Restoring config and stopping.`);
  }
} finally {
  restore();
}

const lineRe = /Assembled reviewer prompt for aspect '([^']+)' on (\S+) is (\d+) chars, over the '([^']+)' tier limit of \d+\./g;
const entries = [];
let match;
while ((match = lineRe.exec(stdout))) {
  entries.push({ aspectId: match[1], unitKey: match[2], chars: Number(match[3]), tierName: match[4] });
}

if (entries.length === 0) {
  log('no LLM pairs found in this graph — nothing to measure.');
  process.exit(0);
}

// Tightest margin per tier — the number that actually decides how much room the next
// edit has, independent of which single aspect the review happened to be looking at.
const byTier = new Map();
for (const e of entries) {
  const list = byTier.get(e.tierName);
  if (list) list.push(e);
  else byTier.set(e.tierName, [e]);
}

let worstMarginOverall = Infinity;
for (const [tierName, list] of byTier) {
  const limit = tierLimits.get(tierName);
  if (limit === undefined) {
    log(`tier '${tierName}' appeared in the measurement but has no committed max_prompt_chars — skipping (config may have changed mid-run).`);
    continue;
  }
  list.sort((a, b) => b.chars - a.chars);
  const worst = list[0];
  const margin = limit - worst.chars;
  worstMarginOverall = Math.min(worstMarginOverall, margin);
  log(`'${tierName}' tier ceiling: ${limit} chars`);
  log(`  largest assembled prompt: ${worst.chars} chars on ${worst.unitKey} (aspect '${worst.aspectId}') — margin ${margin}`);
  for (const next of list.slice(1, 3)) {
    log(`  next tightest: ${next.chars} chars on ${next.unitKey} (aspect '${next.aspectId}') — margin ${limit - next.chars}`);
  }
}

log(`measured ${entries.length} LLM pair(s) across ${byTier.size} tier(s). Tightest margin anywhere: ${worstMarginOverall}.`);
// Reporting only — never fails the gate itself. A prompt that has actually breached
// its ceiling is caught by the real "Graph: check" step that follows this one.
process.exit(0);
