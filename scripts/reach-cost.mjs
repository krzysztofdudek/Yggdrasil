#!/usr/bin/env node
// reach-cost — standing measurement, not a gate.
//
// WHAT it reports: what it costs, on a real graph, to learn which units each rule
// reaches, by each of the two routes that answer that question — `yg aspects --json
// --reach` (the rule inventory, enumerated) and `yg check --json --full` (the gate
// document, whose `pairs[]` a consumer can bucket by rule). Plus the plain
// `yg aspects --json` baseline, so the price of the enumeration itself is visible as
// the difference rather than as an absolute number that means nothing on its own.
//
// WHY it exists as a script and not as a test: a wall-clock comparison is not a
// deterministic assertion. On a contended machine it can flip, and a suite that
// refuses a branch because a laptop was busy teaches the reflex of re-running until
// green. The behaviour that MUST hold on every run — that the enumeration agrees with
// the gate pair for pair, and that the lock, which is what the gate document spends
// its pass on, does not move the enumeration by one byte — is pinned by the test
// suite. What is left over is a number that varies by machine, and a number that
// varies by machine belongs in an instrument you run when you want to know it.
//
// METHOD: each command is run N times (default 5) against a target repository as a
// real subprocess, exactly as a consumer would run it, and the median wall-clock is
// reported. Nothing is written: every command is read-only, none of them takes
// --approve, and the script itself creates no files. Output is a table plus the two
// ratios that decide anything — the enumeration against the baseline (what --reach
// adds) and against the gate document (what it saves).
//
// USAGE: node scripts/reach-cost.mjs [--repo <path>] [--runs <n>] [--bin <path>]
// Defaults: the repository this script lives in, 5 runs, its own built dist/bin.js.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = { repo: REPO_ROOT, runs: 5, bin: path.join(REPO_ROOT, 'source', 'cli', 'dist', 'bin.js') };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) fail(`Missing value for ${flag}.`);
    if (flag === '--repo') args.repo = path.resolve(value);
    else if (flag === '--runs') args.runs = Number(value);
    else if (flag === '--bin') args.bin = path.resolve(value);
    else fail(`Unknown option ${flag}. Usage: node scripts/reach-cost.mjs [--repo <path>] [--runs <n>] [--bin <path>]`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) fail('--runs must be a positive whole number.');
  return args;
}

function fail(message) {
  process.stderr.write(`reach-cost: ${message}\n`);
  process.exit(1);
}

/**
 * Median wall-clock of `runs` real invocations, in milliseconds, plus the size of
 * the document each produces.
 *
 * The timed runs DISCARD their output (`stdio: 'ignore'`): capturing a
 * multi-megabyte document through a pipe costs more than some of the commands
 * being compared, and that cost belongs to this harness, not to the CLI. The size
 * is read once, in a separate run outside the measurement, so the table can say
 * how much document each price buys without paying for it in every sample.
 */
function measure(bin, repo, args, runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    const result = spawnSync('node', [bin, ...args], { cwd: repo, stdio: 'ignore' });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (result.error) fail(`could not run \`yg ${args.join(' ')}\`: ${result.error.message}`);
  }
  samples.sort((a, b) => a - b);
  const sized = spawnSync('node', [bin, ...args], { cwd: repo, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  return { ms: samples[Math.floor(samples.length / 2)], bytes: (sized.stdout ?? '').length };
}

const { repo, runs, bin } = parseArgs(process.argv.slice(2));
if (!existsSync(bin)) fail(`no built CLI at ${bin} — run \`npm run build\` in source/cli first, or pass --bin.`);
if (!existsSync(path.join(repo, '.yggdrasil'))) fail(`${repo} carries no .yggdrasil graph to measure.`);

const cases = [
  ['yg aspects --json', ['aspects', '--json']],
  ['yg aspects --json --reach', ['aspects', '--json', '--reach']],
  ['yg check --json --full', ['check', '--json', '--full']],
];

process.stdout.write(`reach-cost — ${repo}\n  median of ${runs} run${runs === 1 ? '' : 's'} each, read-only, nothing written\n\n`);
const results = new Map();
for (const [label, args] of cases) {
  const r = measure(bin, repo, args, runs);
  results.set(label, r);
  process.stdout.write(`  ${label.padEnd(26)}  ${r.ms.toFixed(0).padStart(6)} ms   ${(r.bytes / 1024).toFixed(0).padStart(6)} KB of document\n`);
}

const plain = results.get('yg aspects --json').ms;
const reach = results.get('yg aspects --json --reach').ms;
const gate = results.get('yg check --json --full').ms;
process.stdout.write(
  `\n  Enumerating every rule's reach adds ${(reach - plain).toFixed(0)} ms to the inventory (${(reach / plain).toFixed(1)}x the plain document),\n` +
    `  and answers in ${(gate / reach).toFixed(1)}x less time than reading the same reach out of the gate document.\n` +
    `  A measurement, not a threshold: nothing here fails, and the numbers are this machine's.\n`,
);
