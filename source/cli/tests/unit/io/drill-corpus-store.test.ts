// =============================================================================
// Unit — a rule's case corpus on disk.
//
// The corpus layout IS the reader's contract:
// `.yggdrasil/aspects/<rule>/drills/<case>/<file>`, where the case directory's
// name prefix carries the verdict the case expects. These cases pin that this
// module writes into exactly that shape and reads back exactly what belongs to
// it — only the two verdict-carrying prefixes, because anything else beneath
// `drills/` is not a case and comparing a new case against it would be
// comparing against something nobody claimed was evidence.
//
// The reader is also deliberately forgiving in one direction only: a rule with
// no cases yet is the normal starting point, not an error, while an unreadable
// case is skipped rather than allowed to take the whole corpus down with it.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  corpusDir,
  readCorpusFiles,
  writeCorpusCase,
  removeCorpusCase,
} from '../../../src/io/drill-corpus-store.js';

const ASPECT = 'billing/charge-audited';

describe('a rule’s case corpus on disk', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-drill-corpus-'));
  });
  afterEach(() => {
    rmSync(yggRoot, { recursive: true, force: true });
  });

  /** Put a file into the corpus behind the module's back, to read it out again. */
  function seed(caseLabel: string, filename: string, content: string): void {
    const dir = path.join(corpusDir(yggRoot, ASPECT), caseLabel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, filename), content, 'utf-8');
  }

  it('puts a rule’s corpus beside the rule, under the name every reader knows', () => {
    expect(corpusDir(yggRoot, ASPECT)).toBe(
      path.join(yggRoot, 'aspects', 'billing', 'charge-audited', 'drills'),
    );
  });

  it('reads a rule with no cases yet as an empty corpus, not an error', async () => {
    // A rule that has never been drilled is the normal starting point.
    await expect(readCorpusFiles(yggRoot, ASPECT)).resolves.toEqual([]);
  });

  it('reads back both verdict prefixes, cases and files each in a settled order', async () => {
    seed('violates-charge-20260906-3a351e1', 'subject.ts', 'const a = 1;\n');
    seed('satisfies-refund-20260101-aaaaaaa', 'b.ts', 'const b = 2;\n');
    seed('satisfies-refund-20260101-aaaaaaa', 'a.ts', 'const c = 3;\n');

    const files = await readCorpusFiles(yggRoot, ASPECT);
    expect(files.map((f) => [f.caseLabel, f.filename])).toEqual([
      ['satisfies-refund-20260101-aaaaaaa', 'a.ts'],
      ['satisfies-refund-20260101-aaaaaaa', 'b.ts'],
      ['violates-charge-20260906-3a351e1', 'subject.ts'],
    ]);
    expect(files[2].content.toString('utf-8')).toBe('const a = 1;\n');
  });

  it('reads a case’s exact bytes, so byte comparison against it means what it says', async () => {
    // The duplicate test a writer makes is byte equality; a decoded-and-
    // re-encoded copy would quietly answer a different question.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const dir = path.join(corpusDir(yggRoot, ASPECT), 'violates-bytes-20260101-aaaaaaa');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'subject.txt'), bytes);

    const [file] = await readCorpusFiles(yggRoot, ASPECT);
    expect(file.content.equals(bytes)).toBe(true);
  });

  it('reads nothing that is not a case, whatever else lives beneath the corpus', async () => {
    seed('violates-charge-20260906-3a351e1', 'subject.ts', 'const a = 1;\n');
    // A directory with no verdict prefix, and a loose file at the top of the
    // corpus — neither is a case, and neither may be compared against one.
    seed('notes', 'why.md', 'a note about the rule\n');
    writeFileSync(path.join(corpusDir(yggRoot, ASPECT), 'README.md'), 'read me\n', 'utf-8');

    const files = await readCorpusFiles(yggRoot, ASPECT);
    expect(files.map((f) => f.caseLabel)).toEqual(['violates-charge-20260906-3a351e1']);
  });

  it('skips a directory inside a case rather than taking it for a file', async () => {
    seed('violates-charge-20260906-3a351e1', 'subject.ts', 'const a = 1;\n');
    mkdirSync(path.join(corpusDir(yggRoot, ASPECT), 'violates-charge-20260906-3a351e1', 'nested'));

    const files = await readCorpusFiles(yggRoot, ASPECT);
    expect(files.map((f) => f.filename)).toEqual(['subject.ts']);
  });

  it('writes a case into the layout the reader expects, and reads it straight back', async () => {
    const written = await writeCorpusCase(
      yggRoot,
      ASPECT,
      'violates-charge-20260906-3a351e1',
      'charge.ts',
      'export function charge() {}\n',
    );

    expect(written).toBe(
      path.join(corpusDir(yggRoot, ASPECT), 'violates-charge-20260906-3a351e1', 'charge.ts'),
    );
    expect(readFileSync(written, 'utf-8')).toBe('export function charge() {}\n');

    const [file] = await readCorpusFiles(yggRoot, ASPECT);
    expect(file).toMatchObject({ caseLabel: 'violates-charge-20260906-3a351e1', filename: 'charge.ts' });
  });

  it('takes a whole case back out, and says nothing about one that was never there', async () => {
    // The removal exists to undo a case this same run just wrote and then could
    // not measure — an unmeasurable case can never fail and says nothing.
    await writeCorpusCase(yggRoot, ASPECT, 'violates-charge-20260906-3a351e1', 'charge.ts', 'x\n');
    await removeCorpusCase(yggRoot, ASPECT, 'violates-charge-20260906-3a351e1');

    expect(existsSync(path.join(corpusDir(yggRoot, ASPECT), 'violates-charge-20260906-3a351e1'))).toBe(false);
    await expect(removeCorpusCase(yggRoot, ASPECT, 'violates-never-written')).resolves.toBeUndefined();
  });
});
