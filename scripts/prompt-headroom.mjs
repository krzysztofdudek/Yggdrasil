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
// not run 'exit' handlers on a signal whose default disposition terminates the process,
// so a Ctrl-C, a closed terminal or a dropped SSH session (SIGHUP), Ctrl-\ (SIGQUIT), or
// a CI job's kill (SIGTERM) partway through this step used to leave the 1-char override
// in place permanently, with no trace in `git status` (the file is gitignored) until the
// next `yg check` mysteriously refuses every LLM pair as prompt-too-large.
// `installInterruptRestore` registers real handlers for every one of those four —
// SIGINT, SIGTERM, SIGHUP, SIGQUIT, every catchable signal a dropped session or a job
// cancellation realistically sends — that call the same `restore()` and then exit with
// the conventional 128+signal code, so the normal path and every one of those four
// interrupted paths all restore the maintainer's exact original bytes. The one
// interruption no handler in any process can ever catch is SIGKILL (a `kill -9` cannot be
// intercepted by any userspace program, in any language) — as a second, independent line
// of defense against exactly that unrecoverable case, the override this script writes is
// never a bare template that replaces the file wholesale: `buildOverrideSecretsText`
// deep-merges the 1-char ceiling INTO whatever the maintainer's overlay already held
// (their provider, endpoint, model, api_key, everything untouched), the same way
// config-parser.ts's own deep-merge treats yg-secrets.yaml as an overlay everywhere else.
// So even in the one scenario nothing in this process can prevent, what a `kill -9` would
// leave behind is the maintainer's own settings with a temporarily-tightened ceiling,
// never an amputated file with their reviewer config gone.
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
//
// MEASUREMENT INTEGRITY: the per-pair char counts come from parsing the engine's
// "Assembled reviewer prompt ... is N chars, over the 'X' tier limit of ..." sentence —
// ordinary CLI copy, free to be reworded like any other what/why/next message. A
// rewording that broke that parse used to make this script report "no LLM pairs found
// ... nothing to measure" and exit 0, on a graph that still has every LLM pair it always
// had — the gauge going dead without a sound. `parsePromptTooLargeEntries` cross-checks
// every sentence it parses against a count of a different kind: how many issues in the
// same output carry the STABLE `prompt-too-large` issue code (a fixed identifier the
// renderer looks up, never prose a wording pass touches) at the start of their own line.
// The two always agree when the sentence parses correctly — a graph-wide run against
// this repository confirms it (1030 sentences, 1030 coded lines) — so any disagreement
// throws instead of silently reporting the (wrong) smaller number. And a run that
// measures ZERO pairs is only ever legitimate when the graph declares no LLM aspect at
// all: `countDeclaredLlmAspects` reads that fact from every aspect the SAME graph-wide
// walk the engine's own loader performs (`readAspectFacts` recurses every subdirectory,
// skipping the reserved `drills` fixture name, exactly like `graph-loader.ts`'s
// `scanAspectsDirectory` — a one-level scan used to see 47 of this repo's 68 aspects)
// and counts an aspect as LLM the same way the real parser infers it (a `content.md`
// with no `reviewer:` block at all, whenever no `check.mjs` sits beside it — not only
// one with an explicit `reviewer.type: llm`), independent of anything `yg check` ever
// prints, so a graph that DOES declare an LLM aspect but measured zero pairs anyway
// fails loudly instead of printing the same quiet "nothing to measure" a genuinely
// LLM-free graph is entitled to. `assertMeasurementComplete` adds a THIRD, independent
// cross-check on top: the same run's own header line — "`N verified (D deterministic, L
// LLM)`", computed from the verification result rather than from any issue text — must
// report an LLM-verified count no greater than the number of prompt-too-large pairs this
// script actually parsed; a killed or `maxBuffer`-truncated child can under-report the
// issue text without touching that header figure, and the shortfall is exactly what
// gives a truncated run away. And `computeTierMargins` never reports a "tightest margin
// anywhere" for a tier it could not resolve a committed ceiling for — a skipped tier
// used to fall through to the next one, silently leaving `Infinity` as the answer
// whenever every measured tier turned out to be unresolvable; now any unresolved tier
// fails the whole run instead, since an unresolved tier could have been the tightest one.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'source/cli/dist/bin.js');
const CONFIG_PATH = path.join(REPO_ROOT, '.yggdrasil/yg-config.yaml');
const SECRETS_PATH = path.join(REPO_ROOT, '.yggdrasil/yg-secrets.yaml');
const ASPECTS_DIR = path.join(REPO_ROOT, '.yggdrasil/aspects');

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
 * How many of `aspectFacts` declare an LLM reviewer — read straight from each
 * aspect's own committed YAML plus the two rule-file facts (`hasContentMd`,
 * `hasCheckMjs`) that sit beside it, entirely independent of anything `yg
 * check` ever prints. Counts an aspect as LLM the same way the real parser
 * (`io/aspect-parser.ts`'s `parseReviewer`) does: an explicit
 * `reviewer.type: llm`, OR a `reviewer:` block that is absent/`null`
 * altogether alongside a `content.md` with no `check.mjs` — the parser's own
 * inferred-llm shape. Pure: takes the raw text and file facts in, never
 * touches the filesystem itself. Used only to tell a graph that genuinely
 * has no LLM aspect (measuring zero pairs is simply correct) apart from one
 * that declares an LLM aspect but measured zero anyway (the measurement
 * broke). A text that fails to parse is skipped rather than thrown on — this
 * is a best-effort ground truth for that one distinction, not the
 * enforcement path itself (yg check already validates every aspect file on
 * its own).
 */
export function countDeclaredLlmAspects(aspectFacts) {
  let count = 0;
  for (const { text, hasContentMd, hasCheckMjs } of aspectFacts) {
    let parsed;
    try {
      parsed = YAML.parse(text);
    } catch {
      continue;
    }
    const reviewer = isPlainObject(parsed) ? parsed.reviewer : undefined;
    if (isPlainObject(reviewer) && reviewer.type === 'llm') count++;
    else if ((reviewer === undefined || reviewer === null) && hasContentMd && !hasCheckMjs) count++;
  }
  return count;
}

/**
 * What "zero LLM pairs measured" means, given how many of the graph's own
 * aspects declare an LLM reviewer. Zero measured pairs is legitimate only
 * when the graph declares no LLM aspect at all — a graph that DOES declare
 * one always measures at least one pair, because the 1-char override
 * guarantees every declared LLM pair trips the §4 gate (see the
 * MEASUREMENT INTEGRITY note at the top of this file), so measuring zero
 * anyway means the measurement itself broke, not that there was nothing to
 * do. Pure: a plain count in, a plain description of what to do out — no
 * filesystem access, no process.exit.
 */
export function classifyZeroMeasurement(declaredLlmAspectCount) {
  if (declaredLlmAspectCount === 0) {
    return { kind: 'nothing-to-measure' };
  }
  return {
    kind: 'broken',
    message:
      `the graph declares ${declaredLlmAspectCount} LLM aspect(s) but this run measured zero prompt-too-large pairs. ` +
      `A healthy run always measures every declared LLM pair (the 1-char override guarantees every one trips the gate), ` +
      `so zero here means the measurement itself broke — a changed override, a mutated check path, or a regression — ` +
      `not that there was nothing to measure. Investigate before trusting a green run.`,
  };
}

/**
 * Exact rendering `check-render-groups.ts` uses for a `prompt-too-large`
 * issue's leading label (`getIssueLabel`): two spaces, the code, two spaces,
 * then the issue's own text — present whether or not the issue also carries
 * a node path (see `parsePromptTooLargeEntries` below). The code is a fixed
 * identifier the renderer looks up, never free-form prose, so it cannot
 * drift the way a what/why/next sentence can.
 */
const PROMPT_TOO_LARGE_LABEL_RE = /^ {2}prompt-too-large {2}/gm;

/**
 * Parse every "Assembled reviewer prompt ... is N chars, over the 'X' tier
 * limit of ..." sentence out of a `yg check --details` run, AND cross-check
 * the count against a wording-independent count of the same fact: how many
 * lines in the same output carry the stable `prompt-too-large` issue code.
 * The two always agree when the sentence's wording matches this parser —
 * they disagree only when something changed the sentence out from under it
 * (an engine wording pass, most commonly), in which case this throws rather
 * than silently returning the smaller (wrong) count. Pure: takes the
 * captured stdout text in, no filesystem access, no process state.
 */
export function parsePromptTooLargeEntries(stdout) {
  const lineRe = /Assembled reviewer prompt for aspect '([^']+)' on (\S+) is (\d+) chars, over the '([^']+)' tier limit of \d+\./g;
  const entries = [];
  let match;
  while ((match = lineRe.exec(stdout))) {
    entries.push({ aspectId: match[1], unitKey: match[2], chars: Number(match[3]), tierName: match[4] });
  }
  const codeLabelCount = (stdout.match(PROMPT_TOO_LARGE_LABEL_RE) ?? []).length;
  if (entries.length !== codeLabelCount) {
    throw new Error(
      `parsed ${entries.length} "Assembled reviewer prompt ..." sentence(s) but ${codeLabelCount} issue(s) in the same ` +
        `output carried the stable 'prompt-too-large' code — the engine's sentence wording likely changed out from under ` +
        `this script's regex. Update the sentence pattern in scripts/prompt-headroom.mjs to match the new wording, then re-run.`,
    );
  }
  return entries;
}

/**
 * The independent LLM-verified count `yg check`'s own header line reports
 * for THIS SAME run — the "`N verified (D deterministic, L LLM)`" segment
 * `check-render-header.ts` prints, computed from the verification result
 * itself rather than from any issue text. Absent entirely means the header
 * printed no verified segment at all, which only happens when the run's
 * total verified count (deterministic + LLM) is exactly zero — so 0 is the
 * correct reading there, not a parse failure. Anchored on a leading digit so
 * it cannot mistake the unrelated "`N unverified (D deterministic-free, L
 * LLM)`" segment for a match: "verified (" is a substring of "unverified (",
 * but no digit ever sits directly in front of "verified" inside that word.
 * Pure: takes the captured stdout text in, no filesystem access.
 */
export function parseHeaderVerifiedLlmCount(stdout) {
  const match = /\d+ verified \(\d+ deterministic, (\d+) LLM\)/.exec(stdout);
  return match ? Number(match[1]) : 0;
}

/**
 * Throws when `entries` (the prompt-too-large pairs this run parsed) is
 * fewer than this SAME run's own header-reported LLM-verified count — the
 * invariant a complete run always satisfies. Under the 1-char override every
 * declared LLM pair either trips the gate fresh (landing in `entries` with
 * no prior valid verdict) or keeps its prior valid verdict while flagged
 * oversized (landing in `entries` AND still counting toward the header's
 * LLM-verified tally) — so `entries.length` can never legitimately fall
 * short of the header's own LLM-verified count. A shortfall means this run's
 * captured output is incomplete (a killed or `maxBuffer`-truncated child),
 * not that there was genuinely less to measure. Pure: takes the parsed
 * entries and the captured stdout text in, no filesystem access.
 */
export function assertMeasurementComplete(entries, stdout) {
  const headerLlmVerified = parseHeaderVerifiedLlmCount(stdout);
  if (entries.length < headerLlmVerified) {
    throw new Error(
      `measured ${entries.length} prompt-too-large pair(s) but this run's own header reports ${headerLlmVerified} verified ` +
        `LLM pair(s) — a complete run always measures at least as many pairs as its own header's LLM-verified count, so this ` +
        `shortfall means the captured output is incomplete (a killed or truncated child process). Re-run this step rather ` +
        `than trust the margin below.`,
    );
  }
}

/**
 * Groups `entries` by tier and computes each tier's tightest margin plus the
 * tightest margin overall — the number that actually decides how much room
 * the next edit has, independent of which single aspect the review happened
 * to be looking at. Throws rather than silently skipping when a measured
 * tier has no entry in `tierLimits` (a maintainer's own local overlay tier,
 * or a config edited mid-run): the script's contract is that it never
 * prints a margin it has not established, and an unresolved tier could have
 * been the tightest one, so falling through to whatever the OTHER tiers
 * leave behind — down to the unresolvable `Infinity` when every tier is
 * skipped — is exactly the false comfort this function refuses to produce.
 * Pure: takes the parsed entries and the resolved tier limits in, no
 * filesystem access, no process state.
 */
export function computeTierMargins(entries, tierLimits) {
  const byTier = new Map();
  for (const e of entries) {
    const list = byTier.get(e.tierName);
    if (list) list.push(e);
    else byTier.set(e.tierName, [e]);
  }
  const tiers = [];
  let worstMarginOverall = Infinity;
  for (const [tierName, list] of byTier) {
    const limit = tierLimits.get(tierName);
    if (limit === undefined) {
      throw new Error(
        `tier '${tierName}' appeared in the measurement but has no committed max_prompt_chars — its tightest margin was ` +
          `never established (config may have changed mid-run). Investigate before trusting any margin from this run.`,
      );
    }
    list.sort((a, b) => b.chars - a.chars);
    const margin = limit - list[0].chars;
    worstMarginOverall = Math.min(worstMarginOverall, margin);
    tiers.push({ tierName, limit, list, margin });
  }
  if (!Number.isFinite(worstMarginOverall)) {
    throw new Error('no tier produced a measurable margin — cannot report a tightest margin.');
  }
  return { tiers, worstMarginOverall };
}

/**
 * Every committed aspect's raw `yg-aspect.yaml` text, plus whether a
 * `content.md` and/or `check.mjs` sit beside it — read fresh on every call.
 * Walks `aspectsDir` the SAME way the engine's own loader does
 * (`graph-loader.ts`'s `scanAspectsDirectory`): recursing into every
 * subdirectory, an aspect id is a relative PATH, not just a top-level folder
 * name, and a directory named `drills` (the loader's own reserved name for a
 * hand-authored regression fixture, never a nested aspect) is never
 * descended into. A one-level scan used to see 47 of this repo's 68 aspects;
 * this sees all of them. Only reached on the zero-measured branch, so the
 * extra read cost never touches the common (nonzero) path. Returns `[]`
 * rather than throwing when `aspectsDir` itself is missing — a project with
 * no aspects directory at all trivially declares zero LLM aspects.
 */
export function readAspectFacts(aspectsDir) {
  if (!existsSync(aspectsDir)) return [];
  const facts = [];
  const walk = (dirPath) => {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml')) {
      facts.push({
        text: readFileSync(path.join(dirPath, 'yg-aspect.yaml'), 'utf-8'),
        hasContentMd: existsSync(path.join(dirPath, 'content.md')),
        hasCheckMjs: existsSync(path.join(dirPath, 'check.mjs')),
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'drills') continue;
      walk(path.join(dirPath, entry.name));
    }
  };
  walk(aspectsDir);
  return facts;
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
 * Every signal `installInterruptRestore` handles, and its conventional
 * 128+signal exit code (POSIX signal numbers: SIGHUP=1, SIGINT=2, SIGQUIT=3,
 * SIGTERM=15). All four are catchable and are the ones a dropped
 * terminal/SSH session, an interactive Ctrl-C, Ctrl-\, or a CI job
 * cancellation realistically sends. SIGKILL cannot appear here — no handler
 * in any process, in any language, can ever be registered for it.
 */
const INTERRUPT_SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

/**
 * Register a handler for every signal in `INTERRUPT_SIGNAL_EXIT_CODES` that
 * calls `restore` and then exits with that signal's conventional 128+signal
 * code. `process.on('exit', restore)` alone never fires for any of them —
 * Node's default disposition for each is immediate termination unless a
 * handler is registered, so without this an ordinary Ctrl-C, a dropped
 * terminal/SSH session, Ctrl-\, or a CI job's kill during this step skips the
 * restore entirely, leaving the 1-char override as the maintainer's new
 * "permanent" config.
 */
export function installInterruptRestore(restore) {
  for (const signal of Object.keys(INTERRUPT_SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      restore();
      process.exit(INTERRUPT_SIGNAL_EXIT_CODES[signal]);
    });
  }
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
  // process.exit() directly. Node does not run 'exit' handlers on a signal whose default
  // disposition terminates the process, so this alone is not sufficient —
  // installInterruptRestore below covers every signal in INTERRUPT_SIGNAL_EXIT_CODES.
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
  // Registered BEFORE installInterruptRestore, for every signal that function handles:
  // Node calls same-event listeners in registration order, and
  // installInterruptRestore's own listener calls process.exit() — once that runs, a
  // listener registered AFTER it never gets a turn.
  for (const signal of Object.keys(INTERRUPT_SIGNAL_EXIT_CODES)) {
    process.on(signal, () => currentChild?.kill(signal));
  }
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

  let entries;
  try {
    entries = parsePromptTooLargeEntries(stdout);
    assertMeasurementComplete(entries, stdout);
  } catch (e) {
    fail(e.message);
  }

  if (entries.length === 0) {
    const declaredLlmAspectCount = countDeclaredLlmAspects(readAspectFacts(ASPECTS_DIR));
    const zero = classifyZeroMeasurement(declaredLlmAspectCount);
    if (zero.kind === 'nothing-to-measure') {
      log("no LLM aspects are declared in this graph's committed rules — nothing to measure.");
      process.exit(0);
    }
    fail(zero.message);
  }

  let tierMargins;
  try {
    tierMargins = computeTierMargins(entries, tierLimits);
  } catch (e) {
    fail(e.message);
  }
  for (const { tierName, limit, list, margin } of tierMargins.tiers) {
    log(`'${tierName}' tier ceiling: ${limit} chars`);
    log(`  largest assembled prompt: ${list[0].chars} chars on ${list[0].unitKey} (aspect '${list[0].aspectId}') — margin ${margin}`);
    for (const next of list.slice(1, 3)) {
      log(`  next tightest: ${next.chars} chars on ${next.unitKey} (aspect '${next.aspectId}') — margin ${limit - next.chars}`);
    }
  }
  const worstMarginOverall = tierMargins.worstMarginOverall;

  log(`measured ${entries.length} LLM pair(s) across ${tierMargins.tiers.length} tier(s). Tightest margin anywhere: ${worstMarginOverall}.`);
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
