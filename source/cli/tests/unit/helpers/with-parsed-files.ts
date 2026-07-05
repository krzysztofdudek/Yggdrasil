import { withParsedFile } from '../../../src/ast/parser.js';
import type { ParsedFile } from '../../../src/relations/extractors/types.js';

/** One (path, code, language) input to withParsedFiles. */
export interface ParseSpec {
  path: string;
  code: string;
  language: string;
}

/**
 * Parse N (path, code, language) specs, keeping every resulting Tree alive
 * simultaneously for the duration of `fn`, and guarantee every Tree is deleted
 * (innermost-first) even if `fn` throws. Built by nesting ast/parser.ts's
 * withParsedFile once per spec — the multi-file analogue tests need when several
 * trees must coexist at once (e.g. building a cross-file SymbolTable before
 * resolving a consumer's use, or a relations reference-case with N embedded
 * files). Trees are parsed and released in the same order specs are given
 * (last spec's tree deleted first, mirroring nested try/finally scoping).
 */
export async function withParsedFiles<T>(
  specs: ParseSpec[],
  fn: (files: ParsedFile[]) => T | Promise<T>,
): Promise<T> {
  const step = (i: number, acc: ParsedFile[]): Promise<T> => {
    if (i === specs.length) return Promise.resolve(fn(acc));
    const s = specs[i];
    return withParsedFile(s.path, s.code, (tree) =>
      step(i + 1, [...acc, { path: s.path, content: s.code, tree, language: s.language }]),
    );
  };
  return step(0, []);
}
