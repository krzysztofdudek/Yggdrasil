import * as fs from 'node:fs';
import * as path from 'node:path';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseTomlSmol } from 'smol-toml';
import { parseFile as parseAstFile, loadedParserFor, grammarDigestForLanguage } from '../ast/parser.js';
import type { ParseCache } from '../ast/parse-cache.js';
import type { Tree } from 'web-tree-sitter';
import { getLanguageForExtension, grammarExtensionForPath } from '../utils/language-registry.js';
import { resolveAllowedReadPath } from './ctx-fs.js';
import type { File } from './types.js';
import type { ObservationRecorder } from './observations.js';
import type { CoverageConfig } from '../model/graph.js';

export interface CtxParsersParams {
  allowedSet: Set<string>;
  projectRoot: string;
  touchedFiles: string[];
  astCache: ParseCache;
  /**
   * Optional observation recorder. When provided, parseYaml/parseJson/parseToml
   * called with a string PATH (not a File object) record a read: observation for
   * the resolved path. File-object calls are not recorded here — the content was
   * already surfaced by ctx.graph or ctx.files and is covered by those observations.
   */
  recorder?: ObservationRecorder;
  /**
   * Set of repo-relative POSIX paths that are subject files for the current run.
   * Reads of these paths via parsers are NOT recorded as observations.
   */
  subjectFiles?: Set<string>;
  /**
   * Repo-relative POSIX paths of separate-project boundaries below the project
   * root — see CtxFsParams.nestedProjectRoots (ctx-fs.ts) for the full contract.
   * A string-path parse call resolving under one of these is rejected the same
   * way ctx.fs.read is. Defaults to empty.
   */
  nestedProjectRoots?: ReadonlySet<string>;
  /** The graph's `coverage` config — see CtxFsParams.coverage (ctx-fs.ts) for the full contract. Defaults to no adopter-configured exclusion. */
  coverage?: CoverageConfig;
  /**
   * Repo-relative POSIX paths `parseAst` may parse on demand when their tree is
   * not cached yet: the unit's own files and its relation targets' files — the
   * set the dispatcher used to parse up front. Their grammars must already be
   * loaded (`loadGrammarsFor`). A path outside it still raises
   * `ParseAstNotPrewarmedError`, exactly as before. Defaults to empty.
   */
  astEligible?: ReadonlySet<string>;
}

export interface CtxParsers {
  parseAst(file: File | string, language: string): unknown;
  parseYaml(file: File | string): unknown;
  parseJson(file: File | string): unknown;
  parseToml(file: File | string): unknown;
}

export class ParseAstNotPrewarmedError extends Error {
  constructor(public readonly filePath: string) {
    super(
      `structure-aspect-parseast-not-prewarmed: ${filePath}. ` +
      `The dispatcher did not prewarm this file. ` +
      `Either (i) add a declared relation to the node owning this file, or ` +
      `(ii) use ctx.parseYaml/Json/Toml if AST is not required.`,
    );
    this.name = 'ParseAstNotPrewarmedError';
  }
}

export function createCtxParsers(params: CtxParsersParams): CtxParsers {
  const { allowedSet, projectRoot, touchedFiles, astCache, recorder, subjectFiles, nestedProjectRoots, coverage, astEligible } = params;

  function asFile(input: File | string): File {
    if (typeof input !== 'string') {
      touchedFiles.push(input.path);
      return input;
    }
    const p = resolveAllowedReadPath(input, allowedSet, projectRoot, nestedProjectRoots, coverage);
    const abs = path.resolve(projectRoot, p);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch (err) {
      // Over-record (spec §3.1): a path-based parser read that passed the
      // allow-check but threw still folds an absent observation before
      // re-throwing — symmetric with ctx.fs.read.
      if (recorder && !(subjectFiles?.has(p))) recorder.recordReadAbsent(p);
      throw err;
    }
    const content = bytes.toString('utf8');
    touchedFiles.push(p);
    // Record a read: observation for path-based calls (the check passed a string
    // path rather than a File object, so we performed a real disk read here).
    if (recorder && !(subjectFiles?.has(p))) {
      recorder.recordRead(p, bytes);
    }
    return { path: p, content };
  }

  return {
    parseAst(file, language) {
      void language;
      const f = asFile(file);
      const cached = astCache.get(f.path);
      if (cached && cached.content === f.content) {
        recordGrammarObservation(recorder, f.path);
        return cached.ast;
      }
      if (astEligible?.has(f.path)) {
        const ast = parseIntoCache(astCache, f.path, f.content);
        if (ast !== undefined) {
          recordGrammarObservation(recorder, f.path);
          return ast;
        }
      }
      throw new ParseAstNotPrewarmedError(f.path);
    },
    parseYaml(file) { return parseYaml(asFile(file).content); },
    parseJson(file) { return JSON.parse(asFile(file).content); },
    parseToml(file) { return parseTomlSmol(asFile(file).content); },
  };
}

// Helper used by dispatcher to prewarmup astCache for a given aspect run.
export async function prewarmupAstCache(params: {
  astCache: ParseCache;
  projectRoot: string;
  files: File[];
}): Promise<void> {
  const { astCache, files } = params;
  for (const f of files) {
    if (!isAstLanguageExtension(f.path)) continue;
    const existing = astCache.get(f.path);
    if (existing && existing.content === f.content) continue;
    const tree = await parseAstFile(f.path, f.content);
    astCache.set(f.path, { content: f.content, ast: tree });
  }
}

/**
 * Fold the grammar that parses `filePath` into the run's observations: called
 * wherever a syntax tree reaches the check or its suppression scan, so the
 * verdict is keyed on the grammar and runtime that built the tree (see the
 * `grammar` observation kind in core/pair-hash.ts). A file with no registered
 * grammar, or no recorder, records nothing.
 */
export { grammarDigestForLanguage };

export function recordGrammarObservation(recorder: ObservationRecorder | undefined, filePath: string): void {
  if (!recorder) return;
  const languageId = getLanguageForExtension(grammarExtensionForPath(filePath));
  if (languageId === null) return;
  const digest = grammarDigestForLanguage(languageId);
  if (digest !== undefined) recorder.recordGrammar(languageId, digest);
}

/**
 * The tree for `filePath` at `content`, parsed now if the cache does not hold
 * one for exactly this content, and cached. Synchronous: it uses a grammar
 * already loaded on this thread (`loadGrammarsFor`) and returns undefined when
 * the file has no registered grammar or its grammar is not loaded.
 *
 * This is what lets a unit's trees be built on first use (a file's `.ast`, a
 * `ctx.parseAst` call, a suppression scan) instead of for every file of the
 * node before the check runs: a text-only rule then parses nothing, and a
 * per-file rule parses its own subject, not the whole node once per worker.
 */
export function parseIntoCache(astCache: ParseCache, filePath: string, content: string): Tree | undefined {
  if (!isAstLanguageExtension(filePath)) return undefined;
  const existing = astCache.get(filePath);
  if (existing && existing.content === content) return existing.ast;
  const parser = loadedParserFor(extname(filePath));
  if (!parser) return undefined;
  const tree = parser.parse(content);
  if (tree === null) throw new Error(`tree-sitter failed to parse file: ${filePath}`);
  astCache.set(filePath, { content, ast: tree });
  return tree;
}

/**
 * `file` with `language` set from the extension registry and `ast` as a getter
 * that parses on first read ({@link parseIntoCache}) — the lazy counterpart of
 * {@link enrichFilesWithAst}. `content` is read through the given accessor, so
 * a caller that defers the file read itself (a non-subject sibling) keeps that
 * deferral: nothing is read or parsed until the check asks.
 */
export function lazyAstFile(
  filePath: string,
  readContent: () => string,
  astCache: ParseCache,
  onContentAccess?: () => void,
  onAstAccess?: () => void,
): File {
  const language = getLanguageForExtension(extname(filePath)) ?? undefined;
  const file = { path: filePath, language } as File;
  Object.defineProperty(file, 'content', {
    enumerable: true,
    configurable: true,
    get(): string {
      onContentAccess?.();
      return readContent();
    },
  });
  Object.defineProperty(file, 'ast', {
    enumerable: true,
    configurable: true,
    get(): unknown {
      onContentAccess?.();
      const ast = parseIntoCache(astCache, filePath, readContent());
      if (ast !== undefined) onAstAccess?.();
      return ast;
    },
  });
  return file;
}

function isAstLanguageExtension(p: string): boolean {
  return getLanguageForExtension(extname(p).toLowerCase()) !== null;
}

/**
 * Return copies of `files` enriched with `language` (from the extension registry) and
 * `ast` (from the prewarmed cache). A file whose extension has no registered grammar gets
 * both undefined. Pure — does not parse; call prewarmupAstCache(files) first.
 * The cache hit requires the SAME content that was prewarmed (cached.content === f.content),
 * so pass the exact File objects that were prewarmed.
 */
export function enrichFilesWithAst(files: File[], astCache: ParseCache): File[] {
  return files.map((f) => {
    const language = getLanguageForExtension(extname(f.path)) ?? undefined;
    const cached = astCache.get(f.path);
    const ast = cached && cached.content === f.content ? cached.ast : undefined;
    return { ...f, ast, language };
  });
}
