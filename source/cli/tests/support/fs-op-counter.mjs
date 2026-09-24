// =============================================================================
// Filesystem and parse operation counter — a `node --import` preload for scale
// tests.
//
// A scale regression is a change in how the WORK grows with the input, and
// wall-clock time on a shared machine is too noisy to pin that down. This
// preload counts the operations instead: every file read, stat and directory
// listing through `node:fs` / `node:fs/promises` (reads of a `.gitignore` also
// under `<call>:.gitignore`), and every tree-sitter parse.
// A test runs the CLI twice on inputs of different size and compares counts.
//
// It patches the builtin modules before the CLI loads (`syncBuiltinESMExports`
// carries the patch into ESM named imports) and web-tree-sitter's
// `Parser.prototype.parse`. It is inherited by the deterministic fill's worker
// threads (they reuse the parent's execArgv), each of which writes its own
// counts file: the main thread at exit, a worker before each reply it posts to
// the parent (a worker is terminated, not exited, so it gets no exit hook).
//
// Environment:
//   YG_OP_COUNT_FILE  path prefix; each thread writes `<prefix>.<thread>` as JSON
//   YG_OP_COUNT_CLI   the CLI package directory (to resolve web-tree-sitter)
//
// Test support only — never shipped, never imported by `src/**`.
// =============================================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isMainThread, threadId, parentPort } from 'node:worker_threads';

const counts = {};
const bump = (key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const wrap = (obj, name, label) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function counted(...args) {
    bump(label);
    if (typeof args[0] === 'string' && args[0].endsWith('.gitignore')) bump(`${label}:.gitignore`);
    return orig.apply(this, args);
  };
};
for (const name of ['readdirSync', 'statSync', 'lstatSync', 'readFileSync', 'accessSync']) wrap(fs, name, `fs.${name}`);
for (const name of ['readdir', 'stat', 'lstat', 'readFile', 'access']) wrap(fsp, name, `fsp.${name}`);
syncBuiltinESMExports();

try {
  const require = createRequire(`${process.env.YG_OP_COUNT_CLI}/package.json`);
  // The CLI imports the ESM entry; require.resolve answers with the CJS one.
  const entry = require.resolve('web-tree-sitter').replace(/\.cjs$/, '.js');
  const { Parser } = await import(pathToFileURL(entry).href);
  const parse = Parser.prototype.parse;
  Parser.prototype.parse = function countedParse(...args) {
    bump('treesitter.parse');
    return parse.apply(this, args);
  };
} catch (err) {
  counts['treesitter.unpatched'] = String(err);
}

const outFile = `${process.env.YG_OP_COUNT_FILE}.${isMainThread ? 'main' : threadId}`;
const flush = () => {
  fs.writeFileSync(outFile, JSON.stringify(counts));
};
if (isMainThread) {
  process.on('exit', flush);
} else if (parentPort) {
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (...args) => {
    flush();
    return post(...args);
  };
}
