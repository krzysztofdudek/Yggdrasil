import { Parser, Language, Tree } from 'web-tree-sitter';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { getGrammarForExtension } from '../utils/language-registry.js';

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Candidate grammar dirs, in order. The published package bundles entry files FLAT
// (dist/bin.js, dist/ast.js …), so the WASM at dist/grammars/ is `__dirname/grammars`.
// `../grammars` covers a legacy dist/ast/ subdir layout and the src/ast/ dev tree.
const GRAMMAR_DIRS = [
  path.resolve(__dirname, 'grammars'),
  path.resolve(__dirname, '..', 'grammars'),
];

// Both the one-time WASM runtime init and each grammar load are memoized as
// PROMISES (not resolved values), set SYNCHRONOUSLY before the first await.
// Under a parallel `yg check --approve`, many deterministic checks call getParser() at
// once. If the flag/value were only set AFTER the await, concurrent callers
// would each re-run Parser.init() / re-load the same grammar, and one could
// observe a half-initialized Language — web-tree-sitter then throws
// `Incompatible language version 0`. Memoizing the in-flight promise makes every
// concurrent caller await the same single init/load. A rejected promise is
// evicted so a later call can retry rather than inheriting a cached failure.
//
// Parser objects are also cached (one per language). Parser construction is
// synchronous once the Language is loaded; reusing them avoids accumulating
// unreleased WASM allocations on large repos where hundreds of pairs are verified
// in one run. Parsers hold no per-parse state (language is set once), so a single
// instance per language is safe to reuse across sequential parse() calls.
let initPromise: Promise<void> | null = null;
const langCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Parser>();

const wasmHashCache = new Map<string, string>();

/**
 * Returns the SHA-256 hex digest of the resolved .wasm bytes for the grammar
 * associated with `extension`, memoized per extension. Computable without
 * triggering a parse or Language.load — safe to call on a cold cache-hit path.
 * Throws (same as resolveWasm) if no grammar exists for the extension.
 */
export function grammarWasmHash(extension: string): string {
  const cached = wasmHashCache.get(extension);
  if (cached !== undefined) return cached;
  const info = getGrammarForExtension(extension);
  if (!info) {
    throw new Error(`no grammar for extension '${extension}'`);
  }
  const wasmPath = resolveWasm(info.wasmFile, info.wasmPackage);
  const hash = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
  wasmHashCache.set(extension, hash);
  return hash;
}

function init(): Promise<void> {
  if (initPromise === null) {
    initPromise = Parser.init();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

function resolveWasm(filename: string, pkg: string): string {
  // Published package: the WASM ships under dist/grammars/.
  for (const dir of GRAMMAR_DIRS) {
    const p = path.join(dir, filename);
    if (existsSync(p)) return p;
  }
  // Dev fallback: resolve from the installed grammar package. This is a devDep, so it
  // is ABSENT in a published install — the dist/grammars path above must succeed there.
  // Wrapped so an absent devDep yields a clean error, not a raw 'Cannot find module'.
  try {
    const pkgDir = path.dirname(_require.resolve(`${pkg}/package.json`));
    for (const candidate of [path.join(pkgDir, filename), path.join(pkgDir, 'bindings/node', filename)]) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* devDep not installed (published package) — fall through to the error below */
  }
  throw new Error(`Could not find WASM grammar ${filename} in dist/grammars/ or in the ${pkg} package.`);
}

export async function getParser(extension: string): Promise<Parser> {
  await init();
  const info = getGrammarForExtension(extension);
  if (!info) {
    throw new Error(`no parser for extension '${extension}'`);
  }
  const cacheKey = info.wasmFile;
  let langP = langCache.get(cacheKey);
  if (langP === undefined) {
    const wasmPath = resolveWasm(info.wasmFile, info.wasmPackage);
    langP = Language.load(wasmPath);
    langCache.set(cacheKey, langP);
    // Evict a failed load so the next caller retries instead of inheriting it.
    langP.catch(() => { if (langCache.get(cacheKey) === langP) langCache.delete(cacheKey); });
  }
  const lang = await langP;
  // Check parser cache AFTER awaiting the language so the first concurrent
  // caller to resume wins the slot; subsequent callers find it already set.
  const existing = parserCache.get(cacheKey);
  if (existing) return existing;
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(cacheKey, parser);
  return parser;
}

export async function parseFile(filePath: string, content: string): Promise<Tree> {
  const ext = path.extname(filePath);
  const parser = await getParser(ext);
  const tree = parser.parse(content);
  if (tree === null) {
    throw new Error(`tree-sitter failed to parse file: ${filePath}`);
  }
  return tree;
}

/**
 * Parse a file, call fn with the resulting Tree, and guarantee tree.delete()
 * in a finally block regardless of whether fn throws. This is the canonical way
 * to use a WASM Tree for a bounded operation — web-tree-sitter Trees are
 * heap-allocated in the WASM module and are not GC-managed by JS.
 *
 * If parseFile itself throws (grammar load failure, parser returns null),
 * the exception propagates and no tree is created — nothing to delete.
 */
export async function withParsedFile<T>(
  filePath: string,
  content: string,
  fn: (tree: Tree) => T | Promise<T>,
): Promise<T> {
  const tree = await parseFile(filePath, content);
  try {
    return await fn(tree);
  } finally {
    tree.delete();
  }
}
