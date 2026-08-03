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
// verdict-hash input, so this invalidates no recorded verdict), runs a plain, read-only
// `yg check` (no --approve — nothing is written), and parses every resulting "Assembled
// reviewer prompt … is N chars" line. The override is restored to its exact original
// bytes (or removed, if none existed) before this script exits, success or failure — a
// trap-style restore that never leaves the repo's real reviewer config altered.
//
// This measures the WHOLE graph, every LLM aspect on every subject, not one aspect in
// isolation — the tightest margin anywhere is what actually decides how much room the
// next edit has, regardless of which aspect's prompt happens to be nearest the ceiling
// today.
//
// INTERRUPTION SAFETY: `process.on('exit', restore)` alone is not enough — Node does
// not run 'exit' handlers on SIGINT/SIGTERM, so a Ctrl-C (or a CI job kill) partway
// through this step used to leave the 1-char override in place permanently, with no
// trace in `git status` (the file is gitignored) until the next `yg check` mysteriously
// refuses every LLM pair as prompt-too-large. `installInterruptRestore` registers real
// SIGINT/SIGTERM handlers that call the same `restore()` and then exit with the
// conventional 128+signal code, so both the normal path and an interrupted one restore
// the maintainer's exact original bytes. The one interruption no handler in any process
// can ever catch is SIGKILL (a `kill -9` cannot be intercepted by any userspace program,
// in any language) — as a second, independent line of defense against exactly that
// unrecoverable case, the override this script writes is never a bare template that
// replaces the file wholesale: `buildOverrideSecretsText` deep-merges the 1-char ceiling
// INTO whatever the maintainer's overlay already held (their provider, endpoint, model,
// api_key, everything untouched), the same way config-parser.ts's own deep-merge treats
// yg-secrets.yaml as an overlay everywhere else. So even in the one scenario nothing in
// this process can prevent, what a `kill -9` would leave behind is the maintainer's own
// settings with a temporarily-tightened ceiling, never an amputated file with their
// reviewer config gone.
//
// CONFIG READING: the real, committed ceiling(s) are parsed with the SAME `yaml`
// package the CLI itself depends on (resolved via createRequire against
// source/cli/package.json, since this script lives outside that package) — never a
// hand-rolled regex over raw text. A regex that does not strip comments can mistake a
// larger number sitting in a comment for the live value (this repo's own `standard`
// tier block carries exactly that shape: years of "raised from N to M" prose wrapped
// around one live line); a real parser cannot make that mistake, and does not care what
// order sibling keys appear in either. `resolveTierLimits` either returns a ceiling for
// every declared tier or throws — this script never prints a margin against a ceiling
// it could not establish.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'source/cli/dist/bin.js');
const CONFIG_PATH = path.join(REPO_ROOT, '.yggdrasil/yg-config.yaml');
const SECRETS_PATH = path.join(REPO_ROOT, '.yggdrasil/yg-secrets.yaml');

// The CLI's own YAML dependency, resolved as if this script were part of
// source/cli — this script has no package.json/node_modules of its own to
// resolve a bare `import 'yaml'` against.
const require = createRequire(path.join(REPO_ROOT, 'source/cli/package.json'));
const YAML = require('yaml');

// A tier that omits max_prompt_chars is gated at the engine's own default —
// core/verify-lock.ts's §4 gate falls back to llm/prompt.ts's
// DEFAULT_MAX_PROMPT_CHARS. Kept in sync with that constant by hand: this
// script cannot cleanly import the CLI's internal bundle (only `./ast` and
// `./structure` are published library entry points), and this repo's own
// tiers always set the value explicitly, so this branch is exercised by
// other adopters' configs, not this repo's own gate.
export const ENGINE_DEFAULT_MAX_PROMPT_CHARS = 50000;

/**
 * Resolve every declared reviewer tier's real max_prompt_chars ceiling from
 * the RAW TEXT of a committed yg-config.yaml. Pure: no filesystem access, no
 * process state. Throws (never silently returns an empty/partial result) when
 * the text cannot be parsed as YAML, when reviewer.tiers is missing, not a
 * mapping, or empty, or when a tier's own max_prompt_chars is present but not
 * a positive integer — every one of those is a case where a caller printing
 * ANY margin would be printing one this function did not actually establish.
 */
export function resolveTierLimits(configText, configPath) {
  let parsed;
  try {
    parsed = YAML.parse(configText);
  } catch (e) {
    throw new Error(`${configPath} did not parse as YAML (${e.message}). Cannot establish a ceiling to measure against.`);
  }
  const reviewer = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.reviewer : undefined;
  const tiersRaw = reviewer && typeof reviewer === 'object' && !Array.isArray(reviewer) ? reviewer.tiers : undefined;
  if (!tiersRaw || typeof tiersRaw !== 'object' || Array.isArray(tiersRaw) || Object.keys(tiersRaw).length === 0) {
    throw new Error(
      `${configPath} has no reviewer.tiers mapping with at least one tier. Cannot establish a ceiling to measure against — yg check itself refuses to run any LLM aspect without one.`,
    );
  }
  const tierLimits = new Map();
  for (const [tierName, tierRaw] of Object.entries(tiersRaw)) {
    if (!tierRaw || typeof tierRaw !== 'object' || Array.isArray(tierRaw)) {
      throw new Error(`${configPath}: reviewer.tiers.${tierName} is not a mapping. Cannot establish its ceiling.`);
    }
    const declared = tierRaw.max_prompt_chars;
    if (declared !== undefined && (typeof declared !== 'number' || !Number.isInteger(declared) || declared <= 0)) {
      throw new Error(
        `${configPath}: reviewer.tiers.${tierName}.max_prompt_chars is ${JSON.stringify(declared)}, not a positive integer. Cannot establish its ceiling.`,
      );
    }
    tierLimits.set(tierName, declared ?? ENGINE_DEFAULT_MAX_PROMPT_CHARS);
  }
  return tierLimits;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge plain objects: `overlay` wins. Nested mappings recurse; scalars,
 * arrays, and mismatched types are replaced wholesale by the overlay value.
 * Pure — mirrors source/cli/src/io/secrets-parser.ts's own `deepMerge` (not
 * imported directly: that module is internal to the CLI's bundle, not a
 * published library entry point this script outside the package can reach).
 */
function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [key, ov] of Object.entries(overlay)) {
    const bv = out[key];
    out[key] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : ov;
  }
  return out;
}

/**
 * Build the TEMPORARY override text this script writes to yg-secrets.yaml —
 * the maintainer's own overlay (parsed, if one existed), deep-merged with a
 * 1-char max_prompt_chars for every tier this run needs to measure. Never a
 * bare template that replaces the file wholesale: a maintainer's real local
 * overlay (their reviewer provider, endpoint, model, api_key) survives
 * untouched alongside the temporary ceiling, so even a SIGKILL — the one
 * interruption `installInterruptRestore` below cannot catch — leaves behind
 * their own settings with a tightened ceiling, never an amputated file.
 * `originalSecretsText` is `null` when no overlay existed yet.
 */
export function buildOverrideSecretsText(originalSecretsText, tierNames) {
  const base = originalSecretsText ? YAML.parse(originalSecretsText) ?? {} : {};
  const tiersOverride = {};
  for (const name of tierNames) tiersOverride[name] = { max_prompt_chars: 1 };
  const merged = deepMerge(isPlainObject(base) ? base : {}, { reviewer: { tiers: tiersOverride } });
  return YAML.stringify(merged);
}

/**
 * Register SIGINT/SIGTERM handlers that call `restore` and then exit with the
 * conventional 128+signal code. `process.on('exit', restore)` alone never
 * fires for either signal — Node's default disposition for both is immediate
 * termination unless a handler is registered, so without this an ordinary
 * Ctrl-C (or a CI job's kill) during this step skips the restore entirely,
 * leaving the 1-char override as the maintainer's new "permanent" config.
 */
export function installInterruptRestore(restore) {
  const onSignal = (signal) => {
    restore();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

function log(m) { process.stdout.write(`[prompt-headroom] ${m}\n`); }
function fail(m) { process.stderr.write(`[prompt-headroom] FAIL: ${m}\n`); process.exit(1); }

async function main() {
  if (!existsSync(BIN_PATH)) fail(`built binary missing at ${BIN_PATH} — run the build step first.`);
  if (!existsSync(CONFIG_PATH)) fail(`no committed config at ${CONFIG_PATH} — is this the repo root?`);

  const configText = readFileSync(CONFIG_PATH, 'utf-8');
  let tierLimits;
  try {
    tierLimits = resolveTierLimits(configText, CONFIG_PATH);
  } catch (e) {
    fail(e.message);
  }

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
  // Last-resort net: restore on a NORMAL exit even if something below throws or calls
  // process.exit() directly. Node does not run 'exit' handlers on SIGINT/SIGTERM, so
  // this alone is not sufficient — installInterruptRestore below covers those two.
  //
  // Both handlers ONLY have a chance to run promptly if the wait for the child `yg
  // check` process does not block the JS event loop: execFileSync's synchronous wait
  // starves the loop entirely, so a SIGINT delivered to just this parent process (the
  // shape a `kill`/CI job-cancel takes; a real terminal Ctrl-C also reaches the child
  // directly, independently) would sit unhandled until the child finishes on its own —
  // silently defeating the whole point of these handlers on a multi-second run. Using
  // the async `execFile` instead keeps the event loop pumping, so a signal's handler
  // fires immediately, mid-wait, not only once the child happens to finish.
  process.on('exit', restore);

  let currentChild;
  // Belt-and-suspenders: if a signal arrives, also terminate the still-running child
  // rather than leave it as an orphaned `yg check` process after this script exits.
  // Registered BEFORE installInterruptRestore: Node calls same-event listeners in
  // registration order, and installInterruptRestore's own listener calls
  // process.exit() — once that runs, a listener registered AFTER it never gets a turn.
  process.on('SIGINT', () => currentChild?.kill('SIGINT'));
  process.on('SIGTERM', () => currentChild?.kill('SIGTERM'));
  installInterruptRestore(restore);

  let stdout = '';
  try {
    // Deep-merged into whatever the maintainer's own overlay already held (see the
    // INTERRUPTION SAFETY note at the top of this file) — never a bare template that
    // would replace their real settings wholesale.
    writeFileSync(SECRETS_PATH, buildOverrideSecretsText(originalSecrets, [...tierLimits.keys()]));

    // --details: the ungrouped, one-block-per-issue view. Plain `yg check`'s default
    // grouped view caps how many distinct groups it prints (falling back to "run
    // --top <n> or --aspect <id>" beyond that) — with every LLM pair now tripping the
    // gate, the pair count alone spans far more groups than that cap allows, and a
    // capped view would silently under-report exactly the tail this script exists to
    // find. --details has no such cap: every pair renders its own block.
    const { error, out } = await new Promise((resolve) => {
      const child = execFile(
        'node',
        [BIN_PATH, 'check', '--details'],
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
        (err, childStdout) => resolve({ error: err, out: childStdout ?? '' }),
      );
      currentChild = child;
    });
    // `yg check` exits 1 whenever anything is unverified/oversized — expected here
    // (every LLM pair now trips the 1-char ceiling). Its stdout is still the report,
    // captured above regardless of exit code.
    stdout = out;
    if (error && !stdout) fail(`yg check produced no output (${error.message}). Restoring config and stopping.`);
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
}

// Only run the side-effecting measurement when invoked directly (`node
// scripts/prompt-headroom.mjs`) — not when a test imports resolveTierLimits
// for its own pure, offline exercise. Same convention as scripts/spectral-headroom.mjs.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
