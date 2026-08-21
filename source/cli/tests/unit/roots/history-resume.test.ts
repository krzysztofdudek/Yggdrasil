import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildHistoryJoin,
  computeInputsHash,
  computeCurrentInputsHash,
  decideWalkMode,
  allRegisteredGrammarBindingHashes,
  historyConfigSubtree,
  HISTORY_STATE_SCHEMA_VERSION,
  parseResumeState,
  deriveStateEpoch,
  type HistoryDeps,
  type InputsHashIngredients,
} from '../../../src/roots/history.js';
import { readHistoryState, type HistoryState } from '../../../src/io/roots-history-store.js';
import { EXTRACTOR_VERSION } from '../../../src/roots/extract.js';
import { withBuiltGolden } from '../helpers/roots-golden-fixture.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';

// =============================================================================
// tests/unit/roots/history-resume.test.ts — the resume machinery's own
// suite: `decideWalkMode`'s trigger set (pure, one case per trigger),
// `computeInputsHash`'s own COMPOSITION (MR-32's killer — a claim about which
// ingredients the hash folds, answerable only by an assertion that isolates
// one ingredient at a time), D2's discard rule (a `--full` run over an
// already-populated state directory must not sum onto it), and the basic
// resume-writes-lastIndexedSha=HEAD correctness property.
//
// The bigger determinism suite (cases (a)-(h), acceptance 1-5) lives in
// tests/e2e/cli-roots-incremental.test.ts, driving the built CLI end to end —
// this file stays at the `buildHistoryJoin`/`decideWalkMode` unit level,
// with no CLI process spawned anywhere.
// =============================================================================

async function makeTempHistoryDeps(): Promise<{ deps: HistoryDeps; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-resume-'));
  return {
    deps: { cacheDir: path.join(dir, 'blobs'), stateDir: path.join(dir, 'history'), ledger: [], dirtyPaths: new Set() },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// decideWalkMode — D2's own trigger list, one unit test per trigger, each
// flipping exactly that one input off the others. MR-31's killer test lives
// at the mutation-round-trip level (deleting the reachability branch), not
// here — this suite only pins the FUNCTION's own behavior.
// ---------------------------------------------------------------------------

describe('decideWalkMode — D2 trigger set', () => {
  const RESUMABLE_STATE = {
    meta: { stateSchemaVersion: 1, stateEpoch: 'e', inputsHash: 'HASH', lastIndexedSha: 'deadbeef' },
    lifecycle: [],
    events: [],
    aliases: [],
    cochangeRaw: [],
    cochange: [],
  };

  it('--full forces a full walk regardless of everything else being resumable', () => {
    const mode = decideWalkMode({
      full: true,
      windowingActive: false,
      state: RESUMABLE_STATE,
      currentInputsHash: 'HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('full');
  });

  it('active windowing (D3) forces a full walk even with an otherwise-resumable state', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: true,
      state: RESUMABLE_STATE,
      currentInputsHash: 'HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('full');
  });

  it('no usable state (undefined — collapses every one of T1\'s own damage shapes: absent, malformed, epoch-disagreeing) forces a full walk', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: false,
      state: undefined,
      currentInputsHash: 'HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('full');
  });

  it('an inputsHash mismatch between the stored state and the current run forces a full walk', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: false,
      state: RESUMABLE_STATE,
      currentInputsHash: 'A-DIFFERENT-HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('full');
  });

  it('MR-31: an unreachable lastIndexedSha forces a full walk — the reachability probe itself, not a stand-in for it', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: false,
      state: RESUMABLE_STATE,
      currentInputsHash: 'HASH',
      isReachable: () => false,
    });
    expect(mode).toBe('full');
  });

  it('none of the triggers firing resumes', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: false,
      state: RESUMABLE_STATE,
      currentInputsHash: 'HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('resume');
  });

  it('a state whose meta.inputsHash is not a string (missing/wrong-typed) forces a full walk — distinct from a differing hash', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: false,
      state: { ...RESUMABLE_STATE, meta: { stateSchemaVersion: 1, stateEpoch: 'e', lastIndexedSha: 'deadbeef' } },
      currentInputsHash: 'HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('full');
  });

  it('a state whose meta.lastIndexedSha is not a string (missing/wrong-typed), inputsHash matching, forces a full walk', () => {
    const mode = decideWalkMode({
      full: false,
      windowingActive: false,
      state: { ...RESUMABLE_STATE, meta: { stateSchemaVersion: 1, stateEpoch: 'e', inputsHash: 'HASH' } },
      currentInputsHash: 'HASH',
      isReachable: () => true,
    });
    expect(mode).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// computeInputsHash — the COMPOSITION test MR-32 names as its own killer.
// A trigger test (above) only proves the hash *differs when it differs*; it
// never proves WHICH ingredients the hash actually folds — dropping one
// silently from the fold would still pass every trigger test unchanged. So:
// one assertion per ingredient, isolating it, plus one assertion that two
// identical tuples hash equal (so the assertions above cannot be satisfied
// by a hash that simply changes on every call).
// ---------------------------------------------------------------------------

describe('computeInputsHash — composition (MR-32\'s killer)', () => {
  const base: InputsHashIngredients = {
    stateSchemaVersion: 1,
    extractorVersion: 'v1',
    grammarBindingHashes: { typescript: 'HASH_TS', python: 'HASH_PY' },
    historyConfigSubtree: { include: ['**/*'], exclude: [], history: { full: true, maxCommits: 0 } },
  };

  it('two identical input tuples hash equal', () => {
    const a = computeInputsHash({ ...base, grammarBindingHashes: { ...base.grammarBindingHashes } });
    const b = computeInputsHash({ ...base, grammarBindingHashes: { ...base.grammarBindingHashes } });
    expect(a).toBe(b);
  });

  it('the STATE SCHEMA VERSION alone changing the hash differs the result and nothing else', () => {
    const a = computeInputsHash(base);
    const b = computeInputsHash({ ...base, stateSchemaVersion: 2 });
    expect(a).not.toBe(b);
  });

  it('the EXTRACTOR VERSION alone changing differs the result', () => {
    const a = computeInputsHash(base);
    const b = computeInputsHash({ ...base, extractorVersion: 'v2' });
    expect(a).not.toBe(b);
  });

  it("a SINGLE grammar's own binding hash changing (nothing else in the map) differs the result", () => {
    const a = computeInputsHash(base);
    const b = computeInputsHash({ ...base, grammarBindingHashes: { ...base.grammarBindingHashes, python: 'HASH_PY_CHANGED' } });
    expect(a).not.toBe(b);
  });

  it('the history:+include/exclude config subtree changing differs the result', () => {
    const baseSubtree = base.historyConfigSubtree as { include: string[]; exclude: string[]; history: unknown };
    const a = computeInputsHash(base);
    const b = computeInputsHash({ ...base, historyConfigSubtree: { ...baseSubtree, include: ['src/**'] } });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// deriveStateEpoch — the SAME composition discipline as computeInputsHash,
// above, extended to D15's own claim: `readHistoryState`'s all-or-nothing
// contract only catches a torn write because the epoch folds all THREE of
// its own ingredients, not because it changes on every call. One assertion
// per ingredient, isolating it, plus the identical-tuples-hash-equal control.
// ---------------------------------------------------------------------------

describe('deriveStateEpoch — composition (D15)', () => {
  const B = [1, 'INPUTS_HASH', 'a'.repeat(40)] as const;

  it('two identical triples derive the same epoch', () => {
    expect(deriveStateEpoch(...B)).toBe(deriveStateEpoch(...B));
  });

  it('the state schema version alone changing differs the epoch', () => {
    expect(deriveStateEpoch(2, B[1], B[2])).not.toBe(deriveStateEpoch(...B));
  });

  it('the inputsHash alone changing differs the epoch', () => {
    expect(deriveStateEpoch(B[0], 'OTHER', B[2])).not.toBe(deriveStateEpoch(...B));
  });

  it('the lastIndexedSha alone changing differs the epoch', () => {
    expect(deriveStateEpoch(B[0], B[1], 'b'.repeat(40))).not.toBe(deriveStateEpoch(...B));
  });
});

describe('computeCurrentInputsHash — the live wrapper agrees with itself and reacts to config', () => {
  it('is stable across two calls with the identical config', async () => {
    const config = await defaultRootsConfig();
    expect(computeCurrentInputsHash(config)).toBe(computeCurrentInputsHash(config));
  });

  it('changes when the history: config subtree changes', async () => {
    const a = await defaultRootsConfig();
    const b = await defaultRootsConfig('history:\n    maxCommits: 5\n');
    expect(computeCurrentInputsHash(a)).not.toBe(computeCurrentInputsHash(b));
  });

  it('folds EVERY registered grammar\'s own binding hash, not only the ones a repo happens to use', () => {
    const hashes = allRegisteredGrammarBindingHashes();
    expect(Object.keys(hashes).length).toBeGreaterThan(1);
    expect(hashes.typescript).toBeDefined();
    expect(hashes.python).toBeDefined();
  });

  it('historyConfigSubtree carries exactly include/exclude/history, nothing else of RootsConfig', async () => {
    const config = await defaultRootsConfig();
    const subtree = historyConfigSubtree(config) as Record<string, unknown>;
    expect(Object.keys(subtree).sort()).toEqual(['exclude', 'history', 'include']);
  });
});

// ---------------------------------------------------------------------------
// D2's discard rule: a `--full` run over an ALREADY-POPULATED state
// directory (non-zero counters, real accumulated rows) must produce exactly
// a from-scratch walk's numbers — never their sum onto what was already
// there.
// ---------------------------------------------------------------------------

describe('buildHistoryJoin — D2 discard rule (--full never sums onto existing state)', () => {
  it('running --full a second time against a stateDir the first run already populated reproduces the SAME numbers, not double them', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const joinA = await buildHistoryJoin(repoRoot, config, deps);
        expect(joinA).toBeDefined();
        if (!joinA) return;
        // The golden's own 25 commits are every one a non-merge (T3) — the
        // first run (no state yet) is necessarily a full walk.
        expect(joinA.historyStats.commits).toBe(25);

        const joinB = await buildHistoryJoin(repoRoot, config, { ...deps, full: true });
        expect(joinB).toBeDefined();
        if (!joinB) return;

        // The discard rule's own killer number: a merge-instead-of-discard
        // bug would report 50 here (25 walked + 25 already accumulated),
        // never 25.
        expect(joinB.historyStats.commits).toBe(25);
        expect(joinB.historyStats).toEqual(joinA.historyStats);
        expect(joinB.lifecycle).toEqual(joinA.lifecycle);
        expect(joinB.cochange).toEqual(joinA.cochange);
        expect(joinB.aliases).toEqual(joinA.aliases);
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// A resumed walk always writes lastIndexedSha === HEAD — "a bug, not a
// fallback" (Step 1's own instruction). Extends the golden with one more
// commit through the public git-fixture primitives and resumes onto it.
// ---------------------------------------------------------------------------

describe('buildHistoryJoin — a resumed walk\'s persisted lastIndexedSha always equals HEAD', () => {
  it('resuming onto one new commit writes meta.json.lastIndexedSha equal to the new HEAD, never the old anchor', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const joinA = await buildHistoryJoin(repoRoot, config, deps);
        expect(joinA).toBeDefined();
        const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();

        // One more, ordinary commit — plain git, no fixture helper needed
        // beyond what every test in this repo already assumes is on PATH.
        execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'chore: one more commit to resume onto'], {
          cwd: repoRoot,
          encoding: 'utf-8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'alice',
            GIT_AUTHOR_EMAIL: 'alice@golden.test',
            GIT_COMMITTER_NAME: 'alice',
            GIT_COMMITTER_EMAIL: 'alice@golden.test',
          },
        });
        const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
        expect(headAfter).not.toBe(headBefore);

        const joinB = await buildHistoryJoin(repoRoot, config, deps);
        expect(joinB).toBeDefined();
        expect(joinB!.clockIso).toBeDefined();

        const state = await readHistoryState(deps.stateDir);
        expect(state).toBeDefined();
        expect(state!.meta.lastIndexedSha).toBe(headAfter);
        expect(state!.meta.lastIndexedSha).not.toBe(headBefore);
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// D3: windowing (maxCommits > 0, even under history.full: true) disables
// resume outright — MR-34's own killer: allowing resume under windowing
// would silently mix two different capped windows.
// ---------------------------------------------------------------------------

describe('D3: windowing disables resume — a capped re-index always matches a FRESH capped --full run, never a mixed-window resume', () => {
  it('indexing with a cap, appending a commit, and re-indexing (deps.full: false) matches an independently-computed fresh capped --full run', async () => {
    const config = await defaultRootsConfig('history:\n    maxCommits: 10\n');
    await withBuiltGolden(buildHistoryGoldenSpec(), async (repoRoot) => {
      const { deps, cleanup } = await makeTempHistoryDeps();
      try {
        const joinA = await buildHistoryJoin(repoRoot, config, deps);
        expect(joinA).toBeDefined();
        // The cap (10) is well under the golden's own 25 commits — a real cap, not a no-op.
        expect(joinA!.historyStats.commits).toBeLessThanOrEqual(10);

        execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'chore: one more, under the cap'], {
          cwd: repoRoot,
          encoding: 'utf-8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'alice',
            GIT_AUTHOR_EMAIL: 'alice@golden.test',
            GIT_COMMITTER_NAME: 'alice',
            GIT_COMMITTER_EMAIL: 'alice@golden.test',
          },
        });

        // A plain re-index (deps.full left false, exactly what `index`
        // without `--full` passes) — D3 says this must STILL be a full
        // (capped) walk, never a resume onto joinA's own state.
        const joinB = await buildHistoryJoin(repoRoot, config, deps);
        expect(joinB).toBeDefined();

        // The reference: an INDEPENDENTLY-computed fresh capped --full walk
        // over the identical current tree, on its own empty state directory.
        const { deps: freshDeps, cleanup: cleanupFresh } = await makeTempHistoryDeps();
        try {
          const joinC = await buildHistoryJoin(repoRoot, config, { ...freshDeps, full: true });
          expect(joinC).toBeDefined();

          // MR-34's own killer number: a resume-under-windowing bug would
          // union joinA's already-capped state onto the new walk, producing
          // a DIFFERENT commit count / lifecycle than a fresh capped walk.
          expect(joinB!.historyStats).toEqual(joinC!.historyStats);
          expect(joinB!.lifecycle).toEqual(joinC!.lifecycle);
        } finally {
          await cleanupFresh();
        }
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// parseResumeState — the state round-trip's own degrade-never-abort rule
// (R4-I10): a malformed row ANYWHERE in a loaded state falls the WHOLE
// state back to "unusable" (undefined), never a partial resume. One valid
// baseline state, then a table of single-field corruptions across every one
// of the six persisted shapes — each must independently make the whole
// parse fail, proving the validation is real per field, not merely present.
// ---------------------------------------------------------------------------

function validLifecycleRow(): Record<string, unknown> {
  return {
    key: 'src/a.ts',
    level: 'file',
    firstSeenTs: 1,
    firstModifiedTs: null,
    lastModifiedTs: 1,
    modifications: 0,
    churnedEarly: false,
    fixTouches: 0,
    authorKind: 'human',
    lastTouchSha: 'sha1',
    lastHumanCommitTs: 1,
  };
}

function validValueTuple(): Record<string, unknown> {
  return {
    nameShape: 'Xx',
    firstStatementType: null,
    returnShape: null,
    decorators: [],
    supertypes: [],
    nodeTypesSeen: [],
    calleeTexts: [],
  };
}

function validEvent(): Record<string, unknown> {
  return {
    key: 'src/a.ts#method#foo',
    ts: 1,
    kind: 'introduction',
    value: validValueTuple(),
    authorHash: 'authorhash',
    authorKind: 'human',
    sha: 'sha1',
  };
}

function validAlias(): Record<string, unknown> {
  return { from: 'src/old.ts', to: 'src/new.ts', ts: 1, sha: 'sha1' };
}

function validCochangePairRow(): Record<string, unknown> {
  return { a: 'src/a.ts', b: 'src/b.ts', support: 1 };
}

function validCochangeFileRow(): Record<string, unknown> {
  return { path: 'src/a.ts', commits: 1 };
}

function validMeta(): Record<string, unknown> {
  return {
    stateSchemaVersion: 1,
    stateEpoch: 'epoch1',
    inputsHash: 'inputshash1',
    lastIndexedSha: 'deadbeef',
    blobShas: ['sha1', 'sha2'],
    parsedKeys: [['key1', 100]],
    commitsAccumulated: 5,
  };
}

function validState(): HistoryState {
  return {
    meta: validMeta() as HistoryState['meta'],
    lifecycle: [validLifecycleRow()],
    events: [validEvent()],
    aliases: [validAlias()],
    cochangeRaw: [validCochangePairRow(), validCochangeFileRow()],
    cochange: [],
  };
}

describe('parseResumeState — the baseline is genuinely valid', () => {
  it('a well-formed state (one row of everything) parses successfully', () => {
    const result = parseResumeState(validState());
    expect(result).toBeDefined();
    expect(result!.lastIndexedSha).toBe('deadbeef');
    expect(result!.replaySnapshot.lifecycle).toHaveLength(1);
    expect(result!.replaySnapshot.events).toHaveLength(1);
    expect(result!.replaySnapshot.aliases).toHaveLength(1);
    expect(result!.cochangeSnapshot.pairs).toHaveLength(1);
    expect(result!.cochangeSnapshot.fileCommits).toHaveLength(1);
    expect(result!.rosters.blobShas.size).toBe(2);
    expect(result!.rosters.parsedKeys.get('key1')).toBe(100);
    expect(result!.rosters.commitsAccumulated).toBe(5);
  });
});

describe('parseResumeState — a single malformed field anywhere makes the WHOLE state unusable (R4-I10)', () => {
  type Mutation = { label: string; mutate: (s: HistoryState) => HistoryState };

  const mutations: Mutation[] = [
    // lifecycle.jsonl (LifecycleRow)
    { label: 'lifecycle row is not an object', mutate: (s) => ({ ...s, lifecycle: [null] }) },
    { label: 'lifecycle.key wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), key: 5 }] }) },
    { label: 'lifecycle.level invalid enum', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), level: 'bogus' }] }) },
    { label: 'lifecycle.firstSeenTs wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), firstSeenTs: '1' }] }) },
    { label: 'lifecycle.firstModifiedTs wrong type (non-null, non-number)', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), firstModifiedTs: 'x' }] }) },
    { label: 'lifecycle.lastModifiedTs wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), lastModifiedTs: 'x' }] }) },
    { label: 'lifecycle.modifications wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), modifications: 'x' }] }) },
    { label: 'lifecycle.churnedEarly wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), churnedEarly: 'x' }] }) },
    { label: 'lifecycle.fixTouches wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), fixTouches: 'x' }] }) },
    { label: 'lifecycle.authorKind invalid enum', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), authorKind: 'bogus' }] }) },
    { label: 'lifecycle.lastTouchSha wrong type', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), lastTouchSha: 5 }] }) },
    { label: 'lifecycle.lastHumanCommitTs wrong type (non-null, non-number)', mutate: (s) => ({ ...s, lifecycle: [{ ...validLifecycleRow(), lastHumanCommitTs: 'x' }] }) },

    // events.jsonl (ValueEvent + its nested ValueTuple)
    { label: 'event row is not an object', mutate: (s) => ({ ...s, events: [42] }) },
    { label: 'event.key wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), key: 5 }] }) },
    { label: 'event.ts wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), ts: 'x' }] }) },
    { label: 'event.kind invalid enum', mutate: (s) => ({ ...s, events: [{ ...validEvent(), kind: 'bogus' }] }) },
    { label: 'event.value is not an object', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: null }] }) },
    { label: 'event.value.nameShape wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), nameShape: 5 } }] }) },
    { label: 'event.value.firstStatementType wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), firstStatementType: 5 } }] }) },
    { label: 'event.value.returnShape wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), returnShape: 5 } }] }) },
    { label: 'event.value.decorators not a string array', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), decorators: [1, 2] } }] }) },
    { label: 'event.value.supertypes not an array', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), supertypes: 'x' } }] }) },
    { label: 'event.value.nodeTypesSeen not a string array', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), nodeTypesSeen: [1] } }] }) },
    { label: 'event.value.calleeTexts not a string array', mutate: (s) => ({ ...s, events: [{ ...validEvent(), value: { ...validValueTuple(), calleeTexts: [1] } }] }) },
    { label: 'event.authorHash wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), authorHash: 5 }] }) },
    { label: 'event.authorKind invalid enum', mutate: (s) => ({ ...s, events: [{ ...validEvent(), authorKind: 'bogus' }] }) },
    { label: 'event.sha wrong type', mutate: (s) => ({ ...s, events: [{ ...validEvent(), sha: 5 }] }) },

    // aliases.jsonl (AliasEdge)
    { label: 'alias row is not an object', mutate: (s) => ({ ...s, aliases: ['x'] }) },
    { label: 'alias.from wrong type', mutate: (s) => ({ ...s, aliases: [{ ...validAlias(), from: 5 }] }) },
    { label: 'alias.to wrong type', mutate: (s) => ({ ...s, aliases: [{ ...validAlias(), to: 5 }] }) },
    { label: 'alias.ts wrong type', mutate: (s) => ({ ...s, aliases: [{ ...validAlias(), ts: 'x' }] }) },
    { label: 'alias.sha wrong type', mutate: (s) => ({ ...s, aliases: [{ ...validAlias(), sha: 5 }] }) },

    // cochange-raw.jsonl (two blocks, discriminated by field presence)
    { label: 'cochange-raw row is not an object', mutate: (s) => ({ ...s, cochangeRaw: [null] }) },
    { label: 'cochange-raw pair row: a wrong type', mutate: (s) => ({ ...s, cochangeRaw: [{ ...validCochangePairRow(), a: 5 }] }) },
    { label: 'cochange-raw pair row: b wrong type', mutate: (s) => ({ ...s, cochangeRaw: [{ ...validCochangePairRow(), b: 5 }] }) },
    { label: 'cochange-raw file row: path wrong type', mutate: (s) => ({ ...s, cochangeRaw: [{ ...validCochangeFileRow(), path: 5 }] }) },
    { label: 'cochange-raw row matches neither shape (no support, no commits)', mutate: (s) => ({ ...s, cochangeRaw: [{ neither: true }] }) },

    // meta.json's own rosters
    { label: 'meta.blobShas not an array', mutate: (s) => ({ ...s, meta: { ...validMeta(), blobShas: 'x' } as unknown as HistoryState['meta'] }) },
    { label: 'meta.blobShas contains a non-string', mutate: (s) => ({ ...s, meta: { ...validMeta(), blobShas: [1] } as unknown as HistoryState['meta'] }) },
    { label: 'meta.parsedKeys not an array', mutate: (s) => ({ ...s, meta: { ...validMeta(), parsedKeys: 'x' } as unknown as HistoryState['meta'] }) },
    { label: 'meta.parsedKeys entry not a 2-tuple', mutate: (s) => ({ ...s, meta: { ...validMeta(), parsedKeys: [['only-one']] } as unknown as HistoryState['meta'] }) },
    { label: 'meta.parsedKeys entry key wrong type', mutate: (s) => ({ ...s, meta: { ...validMeta(), parsedKeys: [[5, 10]] } as unknown as HistoryState['meta'] }) },
    { label: 'meta.parsedKeys entry value wrong type', mutate: (s) => ({ ...s, meta: { ...validMeta(), parsedKeys: [['k', 'v']] } as unknown as HistoryState['meta'] }) },
    { label: 'meta.commitsAccumulated wrong type', mutate: (s) => ({ ...s, meta: { ...validMeta(), commitsAccumulated: 'x' } as unknown as HistoryState['meta'] }) },
    { label: 'meta.lastIndexedSha missing (not a string)', mutate: (s) => ({ ...s, meta: { ...validMeta(), lastIndexedSha: undefined } as unknown as HistoryState['meta'] }) },
  ];

  for (const { label, mutate } of mutations) {
    it(`${label} ⇒ the whole state is unusable (undefined)`, () => {
      expect(parseResumeState(mutate(validState()))).toBeUndefined();
    });
  }
});

// Sanity: HISTORY_STATE_SCHEMA_VERSION and EXTRACTOR_VERSION are both real,
// non-empty exported values a caller could actually fold into inputsHash —
// guards against either module accidentally exporting `undefined`.
describe('exported version constants', () => {
  it('HISTORY_STATE_SCHEMA_VERSION and EXTRACTOR_VERSION are both defined', () => {
    expect(typeof HISTORY_STATE_SCHEMA_VERSION).toBe('number');
    expect(typeof EXTRACTOR_VERSION).toBe('string');
  });
});
