import { describe, it, expect } from 'vitest';
import {
  hashGitBlob,
  gitObjectDigest,
  forceInScopeOnByteMismatch,
  keptByByteGuard,
  progressivePairKey,
  type BurnSet,
  type ByteGuardCandidate,
  type ByteGuardEvidence,
} from '../../../src/core/progressive-scope.js';

const K = progressivePairKey;

// ---------------------------------------------------------------------------
// The byte guard: git's answer, checked against the files' own content.
//
// Every case below hands the decision plain values — a fabricated object-id map
// and buffers — because that is the whole point of the split: the gathering
// half reads the disk, this half only compares. The ONE claim these tests
// cannot make on their own is that the id it computes is really git's; that is
// proved against a real repository in tests/unit/utils/git-introspect.test.ts,
// and end-to-end through the built binary in tests/e2e/cli-progressive-byte-guard.
// ---------------------------------------------------------------------------

/** A burn set with nothing burned, for the guard to widen (or not). */
function emptyBurn(overrides: Partial<BurnSet> = {}): BurnSet {
  return {
    global: false,
    pairKeys: new Set(),
    nodePaths: new Set(['untouched-node']),
    files: new Set(['src/touched.ts']),
    logOnlyNodePaths: new Set(['logged-node']),
    changedInputCount: 1,
    ...overrides,
  };
}

const bytesOf = (text: string): Buffer => Buffer.from(text, 'utf-8');

/** The object id a tree listing would record for exactly this content. */
const oidOf = (text: string): string => hashGitBlob(bytesOf(text));

/** The 64-hex form the same content gets in a repository created with sha256 ids. */
const oid256Of = (text: string): string => hashGitBlob(bytesOf(text), 'sha256');

/**
 * The evidence shape the guard receives: the candidates, plus the component ->
 * rule-check index it reads when re-admitting a component whole. Empty by
 * default — the cases that care about that index pass their own.
 */
const evidence = (
  candidates: ByteGuardCandidate[],
  pairKeysByNode: ReadonlyMap<string, readonly string[]> = new Map(),
): ByteGuardEvidence => ({ candidates, pairKeysByNode });

/** Shorthand for the scope shape the guard receives. */
const scopeOf = (
  burn: BurnSet,
  listing: ReadonlyMap<string, string> | null,
): { burn: BurnSet; blobOidByPath: ReadonlyMap<string, string> | null } => ({
  burn,
  blobOidByPath: listing,
});

describe('hashGitBlob', () => {
  it('is the git object-header form: sha1 over "blob <byteLength>\\0" then the raw bytes', () => {
    // Pinned against a value produced by git itself for this exact content
    // (`printf 'hello\nworld\n' | git hash-object --stdin`), so a refactor that
    // silently changed the header, the length units, or the encoding fails here
    // rather than by making every file in a repository look modified.
    expect(hashGitBlob(bytesOf('hello\nworld\n'))).toBe(
      '94954abda49de8615a048f8d2e64b5de848e27a1',
    );
  });

  it('produces the newer, longer form when the repository uses it', () => {
    // Pinned against git itself in a repository created with
    // `git init --object-format=sha256`:
    //   printf 'hello\nworld\n' | git hash-object --stdin
    // Assuming the older digest on such a repository mismatches every file at
    // once, which forces every inherited finding back in scope and leaves the
    // mode inert with nothing said about it.
    expect(hashGitBlob(bytesOf('hello\nworld\n'), 'sha256')).toBe(
      'fe76325aa5521b207ebe01e12fd8e9e3abf030cacd5398e3744a3a56a81ad1bd',
    );
  });

  it('counts BYTES, not characters', () => {
    // A multi-byte character is where a character-count header goes wrong, and
    // it goes wrong for every file at once.
    const multibyte = Buffer.from('héllo\n', 'utf-8');
    expect(multibyte.length).toBe(7);
    expect(hashGitBlob(multibyte)).not.toBe(hashGitBlob(Buffer.from('hello\n', 'utf-8')));
  });

  it('distinguishes two binary buffers a text decoding would flatten together', () => {
    // 0xFE and 0xFF are both invalid UTF-8 starts and both decode to the SAME
    // replacement character. A text-based comparer calls these two files equal;
    // hashing raw bytes does not.
    const a = Buffer.from([0x00, 0xfe, 0x01]);
    const b = Buffer.from([0x00, 0xff, 0x01]);
    expect(a.toString('utf-8')).toBe(b.toString('utf-8'));
    expect(hashGitBlob(a)).not.toBe(hashGitBlob(b));
  });
});

describe('gitObjectDigest', () => {
  it('reads the repository object format off the recorded ids', () => {
    expect(gitObjectDigest(new Map([['a', oidOf('x')]]))).toBe('sha1');
    expect(gitObjectDigest(new Map([['a', oid256Of('x')]]))).toBe('sha256');
  });

  it('refuses a width it cannot reproduce rather than guessing one', () => {
    expect(gitObjectDigest(new Map([['a', 'deadbeef']]))).toBeNull();
  });

  it('answers for an empty listing, where the answer cannot matter', () => {
    // Nothing is ever hashed against an empty listing — every subject takes the
    // absent-from-the-reference branch — so this only has to be non-null.
    expect(gitObjectDigest(new Map())).toBe('sha1');
  });
});

describe('forceInScopeOnByteMismatch — what it re-admits', () => {
  it('re-admits a pair whose subject bytes moved while git reported no change', () => {
    // The evasion this exists for: the file is edited, the index is told to
    // ignore it, so it never reaches the touched set and its pair falls outside
    // the change. Its content says otherwise.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      evidence([{ pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] }]),
    );
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:hidden')]));
  });

  it('re-admits the FILE and its owning component, not only the rule check', () => {
    // The class the first shape of this guard missed entirely: a finding keyed
    // by a component or by a file is decided by these two sets, never by the
    // rule-check keys, so widening only those left the whole class released on
    // git's false report.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      evidence([{ subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n'), owner: 'svc' }] }]),
    );
    expect(result.files.has('src/hidden.ts')).toBe(true);
    expect(result.nodePaths.has('svc')).toBe(true);
    // No rule check was named, so none was invented.
    expect(result.pairKeys).toEqual(new Set());
  });

  it('counts a re-admitted file as the changed input it is', () => {
    // The header quotes this number as "N changed input(s)". Leaving it at
    // git's count would have the run claim it gated fewer files than it did.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      evidence([{ subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] }]),
    );
    expect(result.changedInputCount).toBe(2);
    expect(result.changedInputCount).toBe(result.files.size);
  });

  it('re-admits only the files that actually moved, never a candidate’s whole list', () => {
    // `files` means "changed paths this run accounted for". A file that did not
    // change is not one of them, and putting it there would make the count in
    // front of a person a claim about their diff that is not true.
    const result = forceInScopeOnByteMismatch(
      scopeOf(
        emptyBurn(),
        new Map([
          ['src/one.ts', oidOf('same\n')],
          ['src/two.ts', oidOf('original\n')],
        ]),
      ),
      evidence([
        {
          pairKey: K('a', 'node:multi'),
          subjects: [
            { path: 'src/one.ts', bytes: bytesOf('same\n'), owner: 'one' },
            { path: 'src/two.ts', bytes: bytesOf('edited\n'), owner: 'two' },
          ],
        },
      ]),
    );
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:multi')]));
    expect(result.files.has('src/two.ts')).toBe(true);
    expect(result.files.has('src/one.ts')).toBe(false);
    expect(result.nodePaths.has('two')).toBe(true);
    expect(result.nodePaths.has('one')).toBe(false);
  });

  it('re-admits every rule check the component owns, not only the candidate’s own', () => {
    // The burn table burns a component WHOLE when one of its files changes; a
    // guard that re-admitted less gave a narrower answer than the honest table
    // for the identical file, and the stage that BUYS reviews then declined the
    // very checks the report was blocking on — a hidden edit to a NEIGHBOURING
    // file in the same component is exactly that shape.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/helper.ts', oidOf('original\n')]])),
      evidence(
        [
          {
            pairKey: K('a', 'file:src/helper.ts'),
            subjects: [{ path: 'src/helper.ts', bytes: bytesOf('edited\n'), owner: 'alpha' }],
          },
        ],
        new Map([['alpha', [K('a', 'file:src/helper.ts'), K('a', 'file:src/alpha.ts')]]]),
      ),
    );
    expect(result.nodePaths.has('alpha')).toBe(true);
    // The neighbour's check too — the file it reviews never moved, but the
    // component it belongs to is now the change's business.
    expect(result.pairKeys).toEqual(
      new Set([K('a', 'file:src/helper.ts'), K('a', 'file:src/alpha.ts')]),
    );
  });

  it('re-admits nothing extra for a component the index does not name', () => {
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      evidence([
        { subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n'), owner: 'orphan' }] },
      ]),
    );
    expect(result.nodePaths.has('orphan')).toBe(true);
    expect(result.pairKeys).toEqual(new Set());
  });

  it('leaves a pair alone when every subject still hashes to the recorded id', () => {
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(
      scopeOf(burnSet, new Map([['src/quiet.ts', oidOf('same\n')]])),
      evidence([{ pairKey: K('a', 'node:quiet'), subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('same\n') }] }]),
    );
    // The very same object, not an equal copy: a run where the guard finds
    // nothing must be indistinguishable from one where it never ran.
    expect(result).toBe(burnSet);
  });

  it('compares against the REPOSITORY’s object format, not one it assumed', () => {
    // A repository created with the newer format records 64-hex ids. Hard-wiring
    // the older digest made every file mismatch, which forced every inherited
    // finding back in scope and left the mode inert with nothing said about it.
    const burnSet = emptyBurn();
    const listing = new Map([['src/quiet.ts', oid256Of('same\n')]]);
    expect(
      forceInScopeOnByteMismatch(scopeOf(burnSet, listing), evidence([
        { pairKey: K('a', 'node:quiet'), subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('same\n') }] },
      ])),
    ).toBe(burnSet);
    // …and a real edit is still caught under that format.
    expect(
      forceInScopeOnByteMismatch(scopeOf(burnSet, listing), evidence([
        { pairKey: K('a', 'node:quiet'), subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('edited\n') }] },
      ])).pairKeys,
    ).toEqual(new Set([K('a', 'node:quiet')]));
  });

  it('compares BINARY subjects correctly instead of forcing them in forever', () => {
    // The trap that would make the guard permanently noisy: deterministic rules
    // keep binary files among their subjects, and a text-decoding comparer
    // mismatches every one of them on every run.
    const logo = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x00, 0x42]);
    const burnSet = emptyBurn();
    const listing = new Map([['src/logo.bin', hashGitBlob(logo)]]);
    const unchanged = forceInScopeOnByteMismatch(scopeOf(burnSet, listing), evidence([
      { pairKey: K('a', 'node:art'), subjects: [{ path: 'src/logo.bin', bytes: logo }] },
    ]));
    expect(unchanged).toBe(burnSet);

    // …and a real edit to those same bytes is still caught.
    const edited = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x00, 0x43]);
    const moved = forceInScopeOnByteMismatch(scopeOf(burnSet, listing), evidence([
      { pairKey: K('a', 'node:art'), subjects: [{ path: 'src/logo.bin', bytes: edited }] },
    ]));
    expect(moved.pairKeys).toEqual(new Set([K('a', 'node:art')]));
  });
});

describe('forceInScopeOnByteMismatch — which way an unanswerable comparison falls', () => {
  it('re-admits a subject whose bytes could not be read at all', () => {
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/gone.ts', oidOf('was here\n')]])),
      evidence([{ pairKey: K('a', 'node:gone'), subjects: [{ path: 'src/gone.ts', bytes: null }] }]),
    );
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:gone')]));
  });

  it('re-admits a subject the reference tree never listed', () => {
    // The file did not exist at the reference, yet the change is reported as
    // never having touched it. Both cannot be true.
    const result = forceInScopeOnByteMismatch(scopeOf(emptyBurn(), new Map()), evidence([
      { pairKey: K('a', 'node:new'), subjects: [{ path: 'src/new.ts', bytes: bytesOf('added\n') }] },
    ]));
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:new')]));
  });

  it('says nothing about a pair with no subject files', () => {
    // Nothing to disagree about, so nothing is proved either way — and the
    // guard never re-admits on an absence of evidence.
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(scopeOf(burnSet, new Map()), evidence([
      { pairKey: K('a', 'type:everything'), subjects: [] },
    ]));
    expect(result).toBe(burnSet);
  });
});

describe('forceInScopeOnByteMismatch — when it declines to run', () => {
  it('is skipped entirely when the reference listing could not be obtained', () => {
    // A null listing is NOT an empty one: reading it as empty would re-admit
    // every candidate, inventing a second failure mode where the measurement
    // already fails closed elsewhere.
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(scopeOf(burnSet, null), evidence([
      { pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] },
    ]));
    expect(result).toBe(burnSet);
  });

  it('is skipped when the recorded ids are in a format it cannot reproduce', () => {
    // Comparing against ids this build cannot make would mismatch every file and
    // force everything in scope; the run declines instead, and the caller says so.
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(scopeOf(burnSet, new Map([['src/hidden.ts', 'deadbeef']])), evidence([
      { pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] },
    ]));
    expect(result).toBe(burnSet);
  });

  it('is skipped under a global scope, which already gates everything', () => {
    const burnSet = emptyBurn({ global: true });
    const result = forceInScopeOnByteMismatch(
      scopeOf(burnSet, new Map([['src/hidden.ts', oidOf('original\n')]])),
      evidence([{ pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] }]),
    );
    expect(result).toBe(burnSet);
  });
});

describe('forceInScopeOnByteMismatch — it can only ADD scope', () => {
  // The one property the whole guard rests on, checked over every combination
  // of the inputs that decide an outcome rather than on one hand-picked case: a
  // wrong "force" costs someone reading a finding that was not theirs, while a
  // wrong "release" ships a real violation green. Every rung of the
  // classification ladder is monotone in these sets, so a superset can only ever
  // keep a finding blocking that would otherwise have been released.
  it('never drops a pair key, a component or a file, and never lowers a count', () => {
    const listings: Array<ReadonlyMap<string, string> | null> = [
      null,
      new Map(),
      new Map([['src/a.ts', 'deadbeef']]),
      new Map([['src/a.ts', oidOf('original\n')]]),
      new Map([['src/a.ts', oidOf('same\n')]]),
      new Map([['src/a.ts', oid256Of('same\n')]]),
    ];
    const subjectSets = [
      [],
      [{ path: 'src/a.ts', bytes: bytesOf('same\n') }],
      [{ path: 'src/a.ts', bytes: bytesOf('edited\n'), owner: 'owner-a' }],
      [{ path: 'src/a.ts', bytes: null, owner: 'owner-a' }],
      [{ path: 'src/missing.ts', bytes: bytesOf('x\n') }],
    ];
    const starts = [
      emptyBurn(),
      emptyBurn({ global: true }),
      emptyBurn({ pairKeys: new Set([K('kept', 'node:one'), K('kept', 'node:two')]) }),
    ];

    for (const start of starts) {
      for (const listing of listings) {
        for (const subjects of subjectSets) {
          for (const pairKey of [K('candidate', 'node:x'), undefined]) {
            const result = forceInScopeOnByteMismatch(scopeOf(start, listing), evidence([{ pairKey, subjects }]));
            for (const key of start.pairKeys) expect(result.pairKeys.has(key)).toBe(true);
            for (const node of start.nodePaths) expect(result.nodePaths.has(node)).toBe(true);
            for (const file of start.files) expect(result.files.has(file)).toBe(true);
            expect(result.global).toBe(start.global);
            expect(result.logOnlyNodePaths).toBe(start.logOnlyNodePaths);
            expect(result.changedInputCount).toBeGreaterThanOrEqual(start.changedInputCount);
            expect(result.changedInputCount).toBe(result.files.size);
            // The only rule check it may ever have added is the candidate's own.
            for (const key of result.pairKeys) {
              if (!start.pairKeys.has(key)) expect(key).toBe(K('candidate', 'node:x'));
            }
            // …and the only component and file, the candidate's own.
            for (const node of result.nodePaths) {
              if (!start.nodePaths.has(node)) expect(node).toBe('owner-a');
            }
            for (const file of result.files) {
              if (!start.files.has(file)) expect(subjects.some((s) => s.path === file)).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('keptByByteGuard', () => {
  const listing = new Map([
    ['src/hidden.ts', oidOf('original\n')],
    ['src/quiet.ts', oidOf('same\n')],
  ]);
  const moved: ByteGuardCandidate = {
    subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }],
  };
  const still: ByteGuardCandidate = {
    subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('same\n') }],
  };

  it('counts a finding whose files the guard re-admitted', () => {
    const before = emptyBurn();
    const after = forceInScopeOnByteMismatch(scopeOf(before, listing), evidence([moved]));
    expect(keptByByteGuard(before, after, [moved])).toBe(1);
  });

  it('counts nothing when the guard re-admitted nothing', () => {
    const before = emptyBurn();
    const after = forceInScopeOnByteMismatch(scopeOf(before, listing), evidence([still]));
    expect(after).toBe(before);
    expect(keptByByteGuard(before, after, [still])).toBe(0);
  });

  it('counts a finding that classification REBUILDS rather than hands back', () => {
    // The aggregate coverage finding is split into two freshly-built halves, so
    // a count tracked by finding identity saw nothing for a run whose only
    // re-admission was an uncovered file — the one case that blocked with no
    // explanation line, which is the case the line exists for.
    const before = emptyBurn();
    const coverage: ByteGuardCandidate = {
      subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }],
    };
    const after = forceInScopeOnByteMismatch(scopeOf(before, listing), evidence([coverage]));
    expect(keptByByteGuard(before, after, [coverage])).toBe(1);
  });

  it('counts each re-admitted finding once, and only the re-admitted ones', () => {
    const before = emptyBurn();
    const after = forceInScopeOnByteMismatch(scopeOf(before, listing), evidence([moved, still]));
    expect(keptByByteGuard(before, after, [moved, still])).toBe(1);
  });
});
