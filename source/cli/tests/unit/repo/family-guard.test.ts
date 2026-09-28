// =============================================================================
// GUARD — Yggdrasil's own code does not reach another family tool, and its
// messages do not name one.
//
// Two checks, both over source/cli/src:
//
// 1. The family guard from @chrisdudek/runes/testkit (vision design §3.2):
//    no import of another tool's package or module, no spawn of its
//    executable, no path built into its state directory, and no exported
//    identifier carrying another tool's domain word. Yggdrasil declares no
//    dependency edge on any family tool, so every such reach is a finding.
//    `node` and `aspect` are Yggdrasil's own vocabulary and are not checked
//    here; the other default domain words are.
//
// 2. No string literal or template text names another family tool. A
//    message that says which tool took over a job ages with that tool: the
//    tool is renamed, split or retired, and the message keeps pointing at it.
//    The family and the documents its tools exchange are described once, on
//    the Family contracts docs page, not in the CLI's output. Lower-case
//    schema ids and producer ids (`grain-proposal/1`, `grain-advice/1`) are
//    contract identifiers, not names in prose, and are not matched.
//
// Hermetic & fast: reads files, spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DOMAIN_WORDS,
  formatGuardReport,
  guardConfig,
  guardPassed,
  runGuard,
  tokenize,
} from '@chrisdudek/runes/testkit';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(CLI_ROOT, 'src');
const EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/** The other family tools, as proper nouns in prose. */
const FAMILY_NAMES = /\b(Grain|Horde|Jarl|Ratatoskr|Urd|Researcher|Skald|Runes)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** Every string or template chunk in the text that names another family tool, with its line. */
function familyNamesInLiterals(text: string): Array<{ line: number; name: string }> {
  const hits: Array<{ line: number; name: string }> = [];
  for (const t of tokenize(text)) {
    if (t.type !== 'string' && t.type !== 'template') continue;
    const m = FAMILY_NAMES.exec(t.value);
    if (m) hits.push({ line: t.line, name: m[1]! });
  }
  return hits;
}

describe('the family guard over Yggdrasil source', () => {
  it('reaches no other family tool by import, spawn or state path, and exports no other tool\'s domain word', () => {
    const report = runGuard({
      root: CLI_ROOT,
      dirs: ['src'],
      config: guardConfig({
        self: 'yggdrasil',
        edges: [],
        domainWords: DEFAULT_DOMAIN_WORDS.filter((t) => t.word !== 'node' && t.word !== 'aspect'),
      }),
    });
    expect(report.files.length).toBeGreaterThan(100);
    expect(guardPassed(report), formatGuardReport(report)).toBe(true);
  });

  it('names no other family tool in any string literal', () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const hit of familyNamesInLiterals(readFileSync(file, 'utf-8'))) {
        found.push(`${path.relative(CLI_ROOT, file)}:${hit.line} names ${hit.name}`);
      }
    }
    expect(found, found.join('\n')).toEqual([]);
  });

  it('the literal check sees names in messages and ignores comments and schema ids', () => {
    const sample = [
      '// Horde reads this in a comment',
      "const a = 'Contract tests are Horde\\'s job now.';",
      'const b = `from a Grain newer than ${x}`;',
      "const c = 'grain-proposal/1';",
    ].join('\n');
    expect(familyNamesInLiterals(sample)).toEqual([
      { line: 2, name: 'Horde' },
      { line: 3, name: 'Grain' },
    ]);
  });
});
