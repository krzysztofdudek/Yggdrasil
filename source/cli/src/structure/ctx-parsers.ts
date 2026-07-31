import * as fs from 'node:fs';
import * as path from 'node:path';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseTomlSmol } from 'smol-toml';
import { parseFile as parseAstFile } from '../ast/parser.js';
import type { ParseCache } from '../ast/parse-cache.js';
import { getLanguageForExtension } from '../utils/language-registry.js';
import { resolveAllowedReadPath } from './ctx-fs.js';
import type { File } from './types.js';
import type { ObservationRecorder } from './observations.js';

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
  const { allowedSet, projectRoot, touchedFiles, astCache, recorder, subjectFiles, nestedProjectRoots } = params;

  function asFile(input: File | string): File {
    if (typeof input !== 'string') {
      touchedFiles.push(input.path);
      return input;
    }
    const p = resolveAllowedReadPath(input, allowedSet, projectRoot, nestedProjectRoots);
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
      if (cached && cached.content === f.content) return cached.ast;
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
