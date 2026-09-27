// =============================================================================
// GUARD — the example READMEs show the check report in today's format.
//
// Every examples/*/README.md walks a reader through one edit and pastes the
// yg check report it produces. Those blocks are hand copies, so when the report
// grammar changed in 6.1.0 (error[label] blocks with at:/why:/fix: fields, a
// lowercase next: line, "files covered" in the header) the examples kept
// showing the retired layout: "Errors (1):" sections, indented "Fix:" lines, a
// capitalised "Next:", and a header counting aspects and flows. This guard
// fails the moment a retired marker appears in a fenced block of any example
// README again, so the old format cannot drift back in.
//
// Hermetic & fast: reads files via fs; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const EXAMPLES = path.join(REPO_ROOT, 'examples');

/** Markers of the report layout retired in 6.1.0, matched per line inside fenced blocks. */
const RETIRED: { pattern: RegExp; what: string }[] = [
  { pattern: /^Errors \(\d+\):/, what: 'an "Errors (N):" section' },
  { pattern: /^Warnings \(\d+\):/, what: 'a "Warnings (N):" section' },
  { pattern: /^Next: /, what: 'a capitalised "Next:" line (today: next:)' },
  { pattern: /^ {4,}(Fix|Why): /, what: 'an indented "Fix:"/"Why:" line (today: fix:/why: fields)' },
  { pattern: /^yg check: (PASS|FAIL) .*\d+ aspects · \d+ flows/, what: 'a header counting aspects and flows' },
  { pattern: /verified \(\d+ deterministic, \d+ LLM\)/, what: 'the old "verified (N deterministic, N LLM)" tally' },
  { pattern: /^yg check: (PASS|FAIL) .*\d+\/\d+ files(?! covered)/, what: 'a header with "files" instead of "files covered"' },
];

function exampleReadmes(): string[] {
  const out = [path.join(EXAMPLES, 'README.md')];
  for (const e of readdirSync(EXAMPLES, { withFileTypes: true })) {
    const readme = path.join(EXAMPLES, e.name, 'README.md');
    if (e.isDirectory() && existsSync(readme)) out.push(readme);
  }
  return out;
}

/** Lines inside ``` fences, with their 1-based line numbers. */
function fencedLines(text: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('```')) inFence = !inFence;
    else if (inFence) out.push({ line, n: i + 1 });
  });
  return out;
}

describe('example READMEs show the current check report', () => {
  it('no fenced block in an examples README uses the retired report layout', () => {
    const files = exampleReadmes();
    expect(files.length).toBeGreaterThan(5);
    const hits: string[] = [];
    let headers = 0;
    for (const file of files) {
      for (const { line, n } of fencedLines(readFileSync(file, 'utf-8'))) {
        if (line.startsWith('yg check: ')) headers++;
        for (const { pattern, what } of RETIRED) {
          if (pattern.test(line)) hits.push(`${path.relative(REPO_ROOT, file)}:${n} shows ${what}`);
        }
      }
    }
    expect(hits).toEqual([]);
    // The guard only means something while the READMEs still paste reports.
    expect(headers).toBeGreaterThan(5);
  });
});
