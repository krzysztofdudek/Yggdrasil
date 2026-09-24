import { Parser, Language, Tree } from 'web-tree-sitter';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getGrammarForExtension, grammarExtensionForPath, LANGUAGES } from '../utils/language-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Candidate grammar dirs, in order. The published package bundles entry files FLAT
// (dist/bin.js, dist/ast.js …), so the WASM at dist/grammars/ is `__dirname/grammars`.
// `../grammars` covers a legacy dist/ast/ subdir layout. `../../dist/grammars` is the
// source tree (src/ast/ → source/cli/dist/grammars): tests and dev runs load the very
// grammars the build pinned and verified, never an npm package that may be a different
// version (several grammars ship from a GitHub release or a source build, not npm).
const GRAMMAR_DIRS = [
  path.resolve(__dirname, 'grammars'),
  path.resolve(__dirname, '..', 'grammars'),
  path.resolve(__dirname, '..', '..', 'dist', 'grammars'),
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
  const wasmPath = resolveWasm(info.wasmFile);
  const hash = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
  wasmHashCache.set(extension, hash);
  return hash;
}

let runtimeHash: string | undefined;

/**
 * SHA-256 of the web-tree-sitter runtime's own `.wasm` — the parsing engine
 * every grammar runs on. Folded into {@link grammarDigest} because a runtime
 * upgrade can change the trees a grammar produces just as a grammar upgrade can.
 */
export function treeSitterRuntimeHash(): string {
  if (runtimeHash === undefined) {
    const wasm = createRequire(import.meta.url).resolve('web-tree-sitter/web-tree-sitter.wasm');
    runtimeHash = createHash('sha256').update(readFileSync(wasm)).digest('hex');
  }
  return runtimeHash;
}

const digestCache = new Map<string, string>();

/**
 * Identity of the syntax trees a file with `extension` gets: SHA-256 over the
 * runtime hash and the grammar wasm hash. Two runs with the same digest parse the
 * same bytes into the same tree, so anything derived from a tree (a relation
 * fact, a deterministic verdict that read an AST) is keyed on it. Throws like
 * {@link grammarWasmHash} when no grammar exists for the extension.
 */
export function grammarDigest(extension: string): string {
  const cached = digestCache.get(extension);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256')
    .update(`web-tree-sitter:${treeSitterRuntimeHash()}\ngrammar:${grammarWasmHash(extension)}`)
    .digest('hex');
  digestCache.set(extension, digest);
  return digest;
}

/**
 * {@link grammarDigest} of a registry language id, or undefined when the id is
 * not a registered language (a grammar that stopped shipping).
 */
export function grammarDigestForLanguage(languageId: string): string | undefined {
  const def = Object.hasOwn(LANGUAGES, languageId) ? LANGUAGES[languageId] : undefined;
  if (!def) return undefined;
  return grammarDigest(def.extensions[0]);
}

function init(): Promise<void> {
  if (initPromise === null) {
    initPromise = Parser.init();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

function resolveWasm(filename: string): string {
  for (const dir of GRAMMAR_DIRS) {
    const p = path.join(dir, filename);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find WASM grammar ${filename} in dist/grammars/. ` +
      `In a source checkout, run \`npm run build\` in source/cli: the build writes the pinned grammars there.`,
  );
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
    const wasmPath = resolveWasm(info.wasmFile);
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

/**
 * Load, on this thread, the grammar of every extension in `extensions` that has
 * one (extensions without a grammar are skipped), so a later synchronous parse
 * ({@link loadedParserFor}) can use it. Loading is the only asynchronous part of
 * parsing; doing it up front for a unit's extensions lets its trees be built on
 * first use instead of all at once before the check runs.
 */
export async function loadGrammarsFor(extensions: Iterable<string>): Promise<void> {
  const seen = new Set<string>();
  for (const ext of extensions) {
    const info = getGrammarForExtension(ext);
    if (!info || seen.has(info.wasmFile)) continue;
    seen.add(info.wasmFile);
    await getParser(ext);
  }
}

/**
 * The parser for `extension` if its grammar is already loaded on this thread,
 * else undefined. Never loads anything — see {@link loadGrammarsFor}.
 */
export function loadedParserFor(extension: string): Parser | undefined {
  const info = getGrammarForExtension(extension);
  if (!info) return undefined;
  return parserCache.get(info.wasmFile);
}

export async function parseFile(filePath: string, content: string): Promise<Tree> {
  const ext = grammarExtensionForPath(filePath);
  // A grammar's external scanner can trap on one pathological input (tree-sitter-ruby
  // 0.23.1 on a heredoc delimiter of 256+ characters). The trap leaves THAT Parser instance
  // unusable: every later parse on it throws the same error, while a fresh Parser over the
  // same loaded Language parses normally. So a throwing parse drops its parser from the
  // cache and is retried ONCE on a private fresh Parser. Concurrent callers may already hold
  // the poisoned instance, so it is not freed (they would hit freed memory instead of a clean
  // throw); they fail on it and take the same retry. The pathological file throws again on
  // its private parser and fails alone; every other file parses.
  let tree: Tree | null;
  const first = await getParser(ext);
  try {
    tree = first.parse(content);
  } catch {
    evictParser(first);
    const fresh = await freshParser(ext);
    try {
      tree = fresh.parse(content);
    } finally {
      fresh.delete(); // the tree does not depend on the parser that built it
    }
  }
  if (tree === null) {
    throw new Error(`tree-sitter failed to parse file: ${filePath}`);
  }
  return tree;
}

/** Drop a Parser that threw mid-parse from the cache (see parseFile), so the next caller
 *  gets a fresh one. It is not freed: a concurrent caller may still hold it. */
function evictParser(parser: Parser): void {
  for (const [key, cached] of parserCache) {
    if (cached === parser) parserCache.delete(key);
  }
}

/** A new Parser for `extension`'s (already loaded or loadable) grammar, outside the cache. */
async function freshParser(extension: string): Promise<Parser> {
  await getParser(extension); // loads the language (and repopulates the cache) if needed
  const info = getGrammarForExtension(extension)!;
  const lang = await langCache.get(info.wasmFile)!;
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
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
