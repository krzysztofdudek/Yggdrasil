// =============================================================================
// Unit — how a real escape becomes a case in a rule's corpus.
//
// A corpus is worth most when it holds the code that actually got past the rule
// rather than a synthetic imitation of it, which means taking a file as it stood
// at a named commit. Everything about that decision is made here and nothing
// here touches git, the filesystem or the clock — so these cases are the whole
// contract: what the case is called, whether the corpus already holds it, and
// what the rule's own history records about it.
//
// Two of those carry the weight. The NAME carries the origin, so a fixture can
// always be traced back to the incident behind it. And the same BYTES never
// enter twice, because a second copy measures nothing and only inflates a count
// people read as coverage.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseCaseSpec,
  slugFor,
  caseLabelFor,
  duplicateOf,
  caseLogEntry,
} from '../../../src/core/drill-add.js';
import type { CorpusFile } from '../../../src/io/drill-corpus-store.js';

/** The parsed halves, or a failure if the spec was refused. */
function parsed(spec: string): { filePath: string; ref: string } {
  const result = parseCaseSpec(spec, '--violates');
  if (!result.ok) throw new Error(`expected '${spec}' to resolve, got: ${result.error.what}`);
  return { filePath: result.filePath, ref: result.ref };
}

/** The refusal, or a failure if the spec resolved. */
function refused(spec: string): { what: string; why: string; next: string } {
  const result = parseCaseSpec(spec, '--violates');
  if (result.ok) throw new Error(`expected '${spec}' to be refused`);
  return result.error;
}

function corpusFile(caseLabel: string, content: string): CorpusFile {
  return { caseLabel, filename: 'subject.ts', content: Buffer.from(content, 'utf8') };
}

describe('naming the file and the commit a case comes from', () => {
  it('reads a path and the commit it stood at', () => {
    expect(parsed('src/billing/charge.ts@a1b2c3d')).toEqual({
      filePath: 'src/billing/charge.ts',
      ref: 'a1b2c3d',
    });
  });

  it('splits on the last separator, so a path that legitimately contains one still resolves', () => {
    // A scoped package directory carries one; the commit half never does.
    expect(parsed('packages/@acme/billing/charge.ts@a1b2c3d')).toEqual({
      filePath: 'packages/@acme/billing/charge.ts',
      ref: 'a1b2c3d',
    });
  });

  it('ignores the whitespace around either half', () => {
    expect(parsed('  src/billing/charge.ts @ a1b2c3d  ')).toEqual({
      filePath: 'src/billing/charge.ts',
      ref: 'a1b2c3d',
    });
  });

  it('refuses a spec missing either half, and shows the form it wants', () => {
    for (const spec of ['src/billing/charge.ts', '@a1b2c3d', 'src/billing/charge.ts@', '', '@']) {
      const error = refused(spec);
      expect(error.what).toContain('is not a file at a commit');
      expect(error.next).toContain('--violates <path>@<commit>');
    }
  });

  it('refuses a path that names something the commit does not contain', () => {
    // The file is read out of the repository at that commit, so an absolute
    // path or one that climbs out of the tree names nothing that can be read.
    for (const spec of ['/etc/passwd@a1b2c3d', '../secrets/key.pem@a1b2c3d', 'src/../../up.ts@a1b2c3d']) {
      expect(refused(spec).what).toContain('is not inside the repository');
    }
  });

  it('leaves a path that merely contains dots alone', () => {
    expect(parsed('src/billing/..charge..ts@a1b2c3d').filePath).toBe('src/billing/..charge..ts');
  });

  it('names the flag it was given, so a refusal points at the argument the user typed', () => {
    const result = parseCaseSpec('nonsense', '--satisfies');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.next).toContain('--satisfies <path>@<commit>');
  });
});

describe('what a case is called', () => {
  it('takes the file’s own name, without its extension, as the readable half', () => {
    expect(slugFor('src/billing/charge.ts')).toBe('charge');
    expect(slugFor('charge.ts')).toBe('charge');
    expect(slugFor('src/billing/Charge Handler.v2.ts')).toBe('charge-handler-v2');
  });

  it('never produces a name beginning or ending with a separator', () => {
    expect(slugFor('src/__init__.py')).toBe('init');
    expect(slugFor('src/-weird-.ts')).toBe('weird');
  });

  it('falls back to a fixed word when the file’s name survives as nothing', () => {
    // A dotfile has no stem at all; a case whose name began with a dash would
    // read as a flag everywhere it is printed.
    expect(slugFor('.env')).toBe('case');
    expect(slugFor('src/config/.gitignore')).toBe('case');
  });

  it('carries the verdict, the file, the day the code existed and the commit', () => {
    const label = caseLabelFor({
      expect: 'violates',
      filePath: 'src/billing/charge.ts',
      commitDate: '2026-09-06',
      commitSha: '3a351e1f9b2c4d5e6f70819202a3b4c5d6e7f809',
    });
    // The verdict prefix stays exactly the corpus convention every reader knows.
    expect(label).toBe('violates-charge-20260906-3a351e1');

    expect(
      caseLabelFor({
        expect: 'satisfies',
        filePath: 'src/billing/refund.ts',
        commitDate: '2026-01-02',
        commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
      }),
    ).toBe('satisfies-refund-20260102-fffffff');
  });

  it('dates the case by the day the code existed, not the day somebody filed it', () => {
    const early = caseLabelFor({
      expect: 'violates',
      filePath: 'a.ts',
      commitDate: '2024-03-01',
      commitSha: 'abc1234def',
    });
    expect(early).toContain('20240301');
  });
});

describe('whether the corpus already holds this case', () => {
  it('finds the case holding these exact bytes, whatever it is called', () => {
    // The same code taken from two commits is one case; a name is not evidence.
    const corpus = [
      corpusFile('violates-charge-20260101-aaaaaaa', 'export const a = 1;\n'),
      corpusFile('violates-charge-20260906-3a351e1', 'export const b = 2;\n'),
    ];
    expect(duplicateOf('export const b = 2;\n', corpus)?.caseLabel).toBe('violates-charge-20260906-3a351e1');
  });

  it('finds nothing when the bytes differ, however slightly, and on an empty corpus', () => {
    const corpus = [corpusFile('violates-charge-20260101-aaaaaaa', 'export const a = 1;\n')];
    expect(duplicateOf('export const a = 1;', corpus)).toBeNull();
    expect(duplicateOf('export const a = 1;\n', [])).toBeNull();
  });
});

describe('what the rule’s own history records about a case that stayed', () => {
  const base = {
    caseLabel: 'violates-charge-20260906-3a351e1',
    filePath: 'src/billing/charge.ts',
    commitSha: '3a351e1f9b2c4d5e6f70819202a3b4c5d6e7f809',
    commitDate: '2026-09-06',
  } as const;

  it('states where the case came from and what the rule is expected to do with it', () => {
    const entry = caseLogEntry({ ...base, expect: 'violates', caught: true, why: 'a real escape' });
    expect(entry).toContain('`src/billing/charge.ts`');
    expect(entry).toContain('commit 3a351e1f9b2c4d5e6f70819202a3b4c5d6e7f809 (2026-09-06)');
    expect(entry).toContain('`violates-charge-20260906-3a351e1`');
    expect(entry).toContain('the rule is expected to refuse');
    expect(entry.endsWith('a real escape')).toBe(true);
  });

  it('records a caught violation as a guard against the behaviour coming back', () => {
    const entry = caseLogEntry({ ...base, expect: 'violates', caught: true, why: null });
    expect(entry).toContain('The rule refuses it, so this case now guards against that behaviour coming back.');
  });

  it('records a missed violation as a standing record of the hole the rule still has', () => {
    // The case stays in the corpus precisely because the rule does not catch it.
    const entry = caseLogEntry({ ...base, expect: 'violates', caught: false, why: null });
    expect(entry).toContain('does NOT refuse it');
    expect(entry).toContain('a hole the rule still has');
  });

  it('records a passing counterpart as a guard against the rule tightening too far', () => {
    const entry = caseLogEntry({
      ...base,
      caseLabel: 'satisfies-charge-20260906-3a351e1',
      expect: 'satisfies',
      caught: false,
      why: null,
    });
    expect(entry).toContain('the rule is expected to pass');
    expect(entry).toContain('starting to refuse code it should allow');
  });

  it('records a false alarm plainly when the rule refuses a case it should pass', () => {
    const entry = caseLogEntry({ ...base, expect: 'satisfies', caught: true, why: null });
    expect(entry).toContain('wrongly refuses it');
    expect(entry).toContain('a false alarm the rule still raises');
  });

  it('says no reason was given rather than inventing one', () => {
    // A log that fabricates a rationale is worse than one that admits it has none.
    const entry = caseLogEntry({ ...base, expect: 'violates', caught: true, why: null });
    expect(entry.endsWith('No reason was given when the case was added.')).toBe(true);
  });
});
