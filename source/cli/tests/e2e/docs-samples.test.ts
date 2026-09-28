// =============================================================================
// CLI E2E — the terminal samples on the docs pages are what the CLI prints.
//
// Every block a page marks `<!-- sample: <name> -->` is recorded from the CLI
// in the samples project (tests/support/docs-samples.ts) and compared with the
// page, so a change to the output fails here until the page shows the new
// output; `npm run docs-samples:update` in source/cli rewrites the blocks. The
// suite only reads. The hand-written excerpts docs-output-samples.test.ts
// compares (the first check after yg init, a cached refusal, the coverage
// stanza) are held there.
//
// Hermetic: the samples project is copied into a temp directory, git is local,
// no reviewer is called.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BIN_PATH, REPO_ROOT } from '../support/cli-help-tree.js';
import { DOCS_SAMPLES, recordSamples, sampleBlocks } from '../support/docs-samples.js';

describe.skipIf(!existsSync(BIN_PATH))('CLI E2E — the docs samples are recorded from the CLI', () => {
  let recorded: Map<string, string>;
  beforeAll(() => {
    recorded = recordSamples();
  }, 120_000);

  it('every registered sample is on its page, exactly as the CLI prints it now', () => {
    const stale: string[] = [];
    for (const s of DOCS_SAMPLES) {
      const blocks = sampleBlocks(readFileSync(path.join(REPO_ROOT, s.page), 'utf-8')).filter((b) => b.name === s.name);
      expect(blocks.length, `${s.page} has no <!-- sample: ${s.name} --> block`).toBeGreaterThan(0);
      for (const b of blocks) if (b.text !== recorded.get(s.name)) stale.push(`${s.page} ${s.name}\n--- page\n${b.text}\n--- CLI\n${recorded.get(s.name)}`);
    }
    expect(stale, 'a docs sample differs from what the CLI prints — run npm run docs-samples:update in source/cli').toEqual([]);
  });

  it('every sample marker on a docs page names a registered sample', () => {
    const known = new Set(DOCS_SAMPLES.map((s) => s.name));
    const docs = path.join(REPO_ROOT, 'docs');
    const unknown = readdirSync(docs)
      .filter((f) => f.endsWith('.md'))
      .flatMap((f) => sampleBlocks(readFileSync(path.join(docs, f), 'utf-8')).map((b) => `docs/${f}: ${b.name}`))
      .filter((entry) => !known.has(entry.split(': ')[1]));
    expect(unknown).toEqual([]);
  });

  it('records real output, not an empty or refused run', () => {
    for (const [name, text] of recorded) {
      expect(text.trim(), name).not.toBe('');
      expect(text, name).not.toMatch(/error\[(?:usage|command-error|internal)\]/);
    }
    expect(recorded.get('aspect-test-refused')).toContain('fs.readFileSync is synchronous');
  });
});
