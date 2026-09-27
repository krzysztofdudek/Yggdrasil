#!/usr/bin/env node
// The grammar step of the build: turns the grammar pins into the two files per language that
// ship in dist/grammars/ — `<wasmFile>` and `<name>.node-types.json`.
//
// The pins, the patches and the recipe come from @chrisdudek/runes/grammars (the grammar
// manifest Yggdrasil and Grain share, so both tools parse a file with the same grammar bytes).
// Yggdrasil ships the grammars of every language in its language table
// (src/utils/language-registry.ts, the Runes table), no more. Every file is written only after
// its bytes matched the pinned sha256, whatever its source: an npm devDependency at its pinned
// version, a GitHub release asset, or a source build at a pinned commit with the pinned
// tree-sitter-cli devDependency. A failing pin writes nothing.
//
// Downloaded and built files land in a content-addressed cache, each named by its sha256
// (YG_GRAMMAR_CACHE, default ~/.cache/yggdrasil/grammars), and are re-hashed on every read: a
// warm cache needs no network and no toolchain, and a damaged entry is evicted, never shipped.
// YG_GRAMMAR_REBUILD=1 ignores the cache and re-derives every non-npm grammar (a
// reproducibility audit). YG_GRAMMAR_OFFLINE=1 forbids downloads and source builds: a grammar
// missing from the cache is an error.
//
// Run by the build (tsup.config.ts onSuccess). Usage:
//   node scripts/grammars.mjs [--out <dir>] [--only <languageId>,...]

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrammars, LANGUAGES } from '@chrisdudek/runes/grammars';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`[grammars] FAIL: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: path.join(CLI_ROOT, 'dist/grammars'), only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') args.only = argv[++i].split(',');
    else fail(`unknown argument ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const table = Object.keys(LANGUAGES);
const unknown = (args.only ?? []).filter((id) => !table.includes(id));
if (unknown.length > 0) fail(`--only names a language the registry does not have: ${unknown.join(', ')}`);
try {
  const built = await buildGrammars({
    outDir: args.out,
    only: args.only ?? table,
    resolveFrom: CLI_ROOT,
    cacheDir: process.env.YG_GRAMMAR_CACHE || path.join(os.homedir(), '.cache', 'yggdrasil', 'grammars'),
    rebuild: process.env.YG_GRAMMAR_REBUILD === '1',
    offline: process.env.YG_GRAMMAR_OFFLINE === '1',
    log: (line) => process.stderr.write(`  [grammars] ${line}\n`),
  });
  process.stdout.write(`Wrote ${built.length} pinned grammars (wasm + node-types.json, sha256-verified) to ${path.relative(CLI_ROOT, args.out) || args.out}/\n`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
