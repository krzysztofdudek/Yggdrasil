import * as TreeSitter from 'web-tree-sitter';
import type { Parser, Tree } from 'web-tree-sitter';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createParserHost, fileSha256 } from '@chrisdudek/runes/ast';

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

// The parser host comes from @chrisdudek/runes/ast (the code both relation consumers share).
// Runes never imports web-tree-sitter by value: Yggdrasil loads its own copy and injects it, so
// grammars, parsers and trees all come from this one runtime. The runtime identity is the
// sha256 of that runtime's own `.wasm`, folded into every grammar digest, because a runtime
// upgrade can change the trees a grammar produces just as a grammar upgrade can. The language
// table is Runes' default (the one src/utils/language-registry.ts re-exports).
//
// The host memoizes the one-time runtime init and each grammar load as PROMISES set before
// the first await, so the many deterministic checks of a parallel `yg check --approve` await
// the same init/load instead of observing a half-loaded Language (`Incompatible language
// version 0`); a rejected promise is evicted so a later call retries. It caches one Parser per
// grammar, and a parse that traps drops its parser and retries once on a fresh one.
const host = createParserHost({
  runtime: TreeSitter,
  runtimeIdentity: () => fileSha256(createRequire(import.meta.url).resolve('web-tree-sitter/web-tree-sitter.wasm')),
  grammarDirs: GRAMMAR_DIRS,
});

/**
 * Returns the SHA-256 hex digest of the resolved .wasm bytes for the grammar
 * associated with `extension`, memoized per extension. Computable without
 * triggering a parse or Language.load — safe to call on a cold cache-hit path.
 * Throws if no grammar exists for the extension.
 */
export function grammarWasmHash(extension: string): string {
  return host.grammarWasmHash(extension);
}

/**
 * Identity of the syntax trees a file with `extension` gets: SHA-256 over the
 * runtime hash and the grammar wasm hash. Two runs with the same digest parse the
 * same bytes into the same tree, so anything derived from a tree (a relation
 * fact, a deterministic verdict that read an AST) is keyed on it. Throws like
 * {@link grammarWasmHash} when no grammar exists for the extension.
 */
export function grammarDigest(extension: string): string {
  return host.grammarDigest(extension);
}

/**
 * {@link grammarDigest} of a registry language id, or undefined when the id is
 * not a registered language (a grammar that stopped shipping).
 */
export function grammarDigestForLanguage(languageId: string): string | undefined {
  return host.grammarDigestForLanguage(languageId);
}

export function getParser(extension: string): Promise<Parser> {
  return host.getParser(extension);
}

/**
 * Load, on this thread, the grammar of every extension in `extensions` that has
 * one (extensions without a grammar are skipped), so a later synchronous parse
 * ({@link loadedParserFor}) can use it. Loading is the only asynchronous part of
 * parsing; doing it up front for a unit's extensions lets its trees be built on
 * first use instead of all at once before the check runs.
 */
export function loadGrammarsFor(extensions: Iterable<string>): Promise<void> {
  return host.loadGrammarsFor(extensions);
}

/**
 * The parser for `extension` if its grammar is already loaded on this thread,
 * else undefined. Never loads anything — see {@link loadGrammarsFor}.
 */
export function loadedParserFor(extension: string): Parser | undefined {
  return host.loadedParserFor(extension);
}

/**
 * A new Parser of this runtime with no language set, outside the cache; the caller deletes
 * it. The Kotlin relation extractor re-parses spans of a file with syntax errors with it
 * (`ParsedFile.newParser`). Needs the runtime initialized, which any earlier parse did.
 */
export function newParser(): Parser {
  return host.newParser();
}

/**
 * Parse `content` with the grammar of `filePath`'s extension, or — when `language` is given —
 * with that language's grammar (the relation pass routes a C++ `.h` header to the C++
 * grammar this way).
 */
export function parseFile(filePath: string, content: string, language?: string): Promise<Tree> {
  return host.parseFile(filePath, content, language);
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
export function withParsedFile<T>(
  filePath: string,
  content: string,
  fn: (tree: Tree) => T | Promise<T>,
  language?: string,
): Promise<T> {
  return host.withParsedFile(filePath, content, fn, language);
}
