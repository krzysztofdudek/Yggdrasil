import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureLoaderRegistered } from '../../../src/ast/loader-hook.js';
import { withParsedFiles } from '../helpers/with-parsed-files.js';
import {
  csharpUses,
  collectGlobalUsings,
  collectGlobalUsingAliases,
  extractCsharpRefs,
  assembleCsharpCandidates,
} from '../../../src/relations/extractors/csharp.js';
import type { ParsedFile } from '../../../src/relations/extractors/types.js';

/**
 * Parity oracle for the C# extract/assemble split.
 *
 * The C# catalogue under reference/relations/csharp/*.md is a READ-ONLY oracle. This test
 * loads every ```csharp path=…``` snippet from those files (mirroring reference-case-runner's
 * `## Files` parsing — never edited to fit the split), parses each into a `ParsedFile`, and
 * asserts that the two-phase pipeline
 *     assembleCsharpCandidates(extractCsharpRefs(pf), options)
 * deep-equals the single-phase public entry
 *     csharpUses(pf, options)
 * byte-identically — for representative `options` INCLUDING the cross-file project-global
 * usings + aliases that the C# pre-pass aggregates (the exact seam the split must preserve).
 */

const CATALOGUE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../reference/relations/csharp',
);

interface CsharpSnippet {
  caseId: string;
  filePath: string; // repo-rel POSIX path declared in the ```csharp path=…``` block
  code: string;
}

/** Extract the text under a `## <name>` heading, up to the next `## ` heading or EOF. */
function sectionBody(body: string, name: string): string | undefined {
  const re = new RegExp(`(^|\\n)##\\s+${name}\\s*\\n`);
  const start = re.exec(body);
  if (!start) return undefined;
  const from = start.index + start[0].length;
  const rest = body.slice(from);
  const next = /\n##\s+/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Load every ```csharp path=…``` snippet from every catalogue `.md` (read-only). */
function loadCsharpSnippets(): CsharpSnippet[] {
  const out: CsharpSnippet[] = [];
  for (const entry of readdirSync(CATALOGUE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const caseId = entry.name.slice(0, -'.md'.length);
    const text = readFileSync(path.join(CATALOGUE_ROOT, entry.name), 'utf-8');
    const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const body = fmMatch ? text.slice(fmMatch[0].length) : text;
    const filesSection = sectionBody(body, 'Files');
    if (filesSection === undefined) continue;
    const fenceRe = /```csharp\s+path=([^\s`]+)\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(filesSection)) !== null) {
      out.push({ caseId, filePath: m[1].trim(), code: m[2] });
    }
  }
  return out;
}

/** Group snippets by case so the cross-file global-using pre-pass runs per case, exactly as
 *  reference-case-runner aggregates `collectGlobalUsings` / `collectGlobalUsingAliases`. */
function groupByCase(snippets: CsharpSnippet[]): Map<string, CsharpSnippet[]> {
  const byCase = new Map<string, CsharpSnippet[]>();
  for (const s of snippets) {
    const list = byCase.get(s.caseId) ?? [];
    list.push(s);
    byCase.set(s.caseId, list);
  }
  return byCase;
}

describe('C# extract/assemble parity', () => {
  it('assemble(extract(pf), opts) equals csharpUses(pf, opts) for every catalogue snippet', async () => {
    ensureLoaderRegistered();
    const snippets = loadCsharpSnippets();
    expect(snippets.length).toBeGreaterThan(0);

    const byCase = groupByCase(snippets);
    let assertions = 0;

    for (const [, caseSnippets] of byCase) {
      // Parse every file in the case — all trees kept alive simultaneously for the
      // duration of this case (cross-file resolution needs them together), and every
      // one guaranteed deleted (LIFO) once the case's assertions below finish.
      await withParsedFiles(
        caseSnippets.map((s) => ({ path: s.filePath, code: s.code, language: 'csharp' })),
        (files) => {
          const parsed = new Map<string, ParsedFile>();
          caseSnippets.forEach((s, i) => parsed.set(s.filePath, files[i]));

          // Build the cross-file project-global using scope exactly as the pre-pass does.
          const globalUsings = new Set<string>();
          const globalAliasMap = new Map<string, string>();
          for (const s of caseSnippets) {
            const pf = parsed.get(s.filePath)!;
            for (const prefix of collectGlobalUsings(pf)) globalUsings.add(prefix);
            for (const [name, fqn] of collectGlobalUsingAliases(pf)) globalAliasMap.set(name, fqn);
          }
          const projectGlobalUsings = [...globalUsings];
          const projectGlobalUsingAliases = [...globalAliasMap.entries()];

          // Representative option sets: the empty default AND the cross-file aggregated scope.
          const optionVariants = [
            {},
            { projectGlobalUsings, projectGlobalUsingAliases },
            { projectGlobalUsings },
            { projectGlobalUsingAliases },
          ];

          for (const s of caseSnippets) {
            const pf = parsed.get(s.filePath)!;
            for (const options of optionVariants) {
              const viaSplit = assembleCsharpCandidates(extractCsharpRefs(pf), options);
              const viaDirect = csharpUses(pf, options);
              expect(
                viaSplit,
                `parity mismatch for ${s.caseId} / ${s.filePath} with options ${JSON.stringify(options)}`,
              ).toEqual(viaDirect);
              assertions++;
            }
          }
        },
      );
    }

    expect(assertions).toBeGreaterThan(0);
  });
});
