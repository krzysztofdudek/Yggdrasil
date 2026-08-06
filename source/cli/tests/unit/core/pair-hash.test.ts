/**
 * Tests for core/pair-hash.ts — frozen input-hash contract (spec §3.1).
 *
 * Golden values pin the serialization format. Changing them is a deliberate
 * breaking decision — see pair-hash-golden.json for the canonical fixture.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LlmHashInput, DetHashInput } from '../../../src/core/pair-hash.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';
import {
  contentFor,
  ruleHashFor,
  companionHashFor,
  nodeDescriptionFor,
  tierHashViewFromTier,
} from '../../../src/core/pair-inputs.js';
import {
  codePointCanonicalJson,
  computeLlmInputHash,
  computeDetInputHash,
  observationKey,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
  tierHashView,
} from '../../../src/core/pair-hash.js';

// ---------------------------------------------------------------------------
// Load golden fixture
// ---------------------------------------------------------------------------

const GOLDEN_PATH = join(import.meta.dirname, '../../fixtures/pair-hash-golden.json');

interface PairHashGolden {
  // BREAKING: changing any of these values is a deliberate decision (spec §3.1 frozen contract).
  llmInputHash: string;
  hashListObservationGolden: string;
  /** Canonical form for a file enforced by its architecture type alone. */
  virtualDeterministic: string;
  virtualLlm: string;
}

const golden: PairHashGolden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));

// ---------------------------------------------------------------------------
// Shared fixture inputs
// ---------------------------------------------------------------------------

const BASE_LLM_INPUT: LlmHashInput = {
  aspectId: 'input-validation',
  aspectDescription: 'Every handler must validate its input before processing.',
  scope: undefined,
  nodePath: 'billing/cancel',
  ruleHash: 'a'.repeat(64),
  files: [
    ['src/billing/cancel.ts', 'b'.repeat(64)],
    ['src/billing/utils.ts', 'c'.repeat(64)],
  ],
  references: [
    ['docs/validation-catalogue.md', 'd'.repeat(64), 'Input validation catalogue'],
  ],
  tier: {
    name: 'standard',
  },
  verdict: 'approved',
};

// ---------------------------------------------------------------------------
// codePointCanonicalJson — key ordering
// ---------------------------------------------------------------------------

describe('codePointCanonicalJson', () => {
  it('canonical serialization uses code-point key ordering', () => {
    // Code-point order: 'Z' (0x5A) < '_' (0x5F) < 'a' (0x61)
    const obj = { alpha: 1, _under: 2, Zeta: 3 };
    const json = codePointCanonicalJson(obj);
    // Keys must appear in code-point order
    const keyOrder = (json.match(/"(\w+)":/g) ?? []).map((m) => m.slice(1, -2));
    expect(keyOrder).toEqual(['Zeta', '_under', 'alpha']);

    // Assertion that localeCompare would differ:
    // localeCompare-based sort typically yields: '_under', 'alpha', 'Zeta'
    // (underscore sorts after letters in many locales)
    const localeOrder = ['alpha', '_under', 'Zeta'].sort((a, b) => a.localeCompare(b));
    expect(localeOrder).not.toEqual(['Zeta', '_under', 'alpha']);
  });

  it('nested objects also use code-point key ordering', () => {
    const obj = { b: { z: 1, a: 2 }, a: 3 };
    const json = codePointCanonicalJson(obj);
    expect(json).toBe('{"a":3,"b":{"a":2,"z":1}}');
  });

  it('arrays preserve element order', () => {
    const json = codePointCanonicalJson([3, 1, 2]);
    expect(json).toBe('[3,1,2]');
  });

  it('undefined values are omitted', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const json = codePointCanonicalJson(obj);
    expect(json).toBe('{"a":1,"c":3}');
  });
});

// ---------------------------------------------------------------------------
// LLM hash — golden pin
// ---------------------------------------------------------------------------

describe('computeLlmInputHash', () => {
  it('LLM hash matches pinned golden for the fixture input', () => {
    // BREAKING: this value is pinned in pair-hash-golden.json (spec §3.1 frozen contract).
    // Changing serialization or ingredients requires a deliberate breaking decision.
    const hash = computeLlmInputHash(BASE_LLM_INPUT);
    expect(hash).toBe(golden.llmInputHash);
  });

  it('verdict token changes the hash', () => {
    const approved = computeLlmInputHash({ ...BASE_LLM_INPUT, verdict: 'approved' });
    const refused = computeLlmInputHash({ ...BASE_LLM_INPUT, verdict: 'refused' });
    expect(approved).not.toBe(refused);
  });

  it('absent scope hashes identically to explicit {per:"node"} with no files filter', () => {
    const withUndefined = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: undefined });
    const withExplicit = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: { per: 'node' } });
    expect(withUndefined).toBe(withExplicit);
  });

  it('tier config (provider/model/temperature/consensus/api_key/timeout) does not affect the hash — only the name folds in', () => {
    // Same tier name, wildly different resolved config → identical hash.
    const tierA = tierHashView('standard');
    const tierB = tierHashView('standard');
    const hashA = computeLlmInputHash({ ...BASE_LLM_INPUT, tier: tierA });
    const hashB = computeLlmInputHash({ ...BASE_LLM_INPUT, tier: tierB });
    expect(hashA).toBe(hashB);
    // tierHashView never exposes config at all — swapping the model behind the
    // name is invisible to the hash by construction.
    expect(tierA).toEqual({ name: 'standard' });
  });

  it('tier NAME changes the hash', () => {
    const standard = computeLlmInputHash({ ...BASE_LLM_INPUT, tier: tierHashView('standard') });
    const thorough = computeLlmInputHash({ ...BASE_LLM_INPUT, tier: tierHashView('thorough') });
    expect(standard).not.toBe(thorough);
  });

  it('aspect description affects the hash', () => {
    const hash1 = computeLlmInputHash({ ...BASE_LLM_INPUT, aspectDescription: 'Rule A' });
    const hash2 = computeLlmInputHash({ ...BASE_LLM_INPUT, aspectDescription: 'Rule B' });
    expect(hash1).not.toBe(hash2);
  });

  it('file order does not matter (sorted internally by path)', () => {
    const sorted = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [
        ['src/billing/cancel.ts', 'b'.repeat(64)],
        ['src/billing/utils.ts', 'c'.repeat(64)],
      ],
    });
    const reversed = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [
        ['src/billing/utils.ts', 'c'.repeat(64)],
        ['src/billing/cancel.ts', 'b'.repeat(64)],
      ],
    });
    expect(sorted).toBe(reversed);
  });

  it('paths are POSIX-normalized before folding (backslash input hashes equal to forward-slash input)', () => {
    const posix = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [['src/billing/cancel.ts', 'b'.repeat(64)]],
    });
    const windows = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [['src\\billing\\cancel.ts', 'b'.repeat(64)]],
    });
    expect(posix).toBe(windows);
  });

  it('plain input (no companionHash, no touched) still equals the golden — backward compat', () => {
    expect(computeLlmInputHash(BASE_LLM_INPUT)).toBe(golden.llmInputHash);
  });

  it('empty touched array hashes identically to absent (independent length-0 guard)', () => {
    const withEmpty = computeLlmInputHash({ ...BASE_LLM_INPUT, touched: [] });
    expect(withEmpty).toBe(golden.llmInputHash);
  });

  it('companionHash folds INDEPENDENT of touched: present companionHash + absent touched differs from plain', () => {
    const withCompanion = computeLlmInputHash({ ...BASE_LLM_INPUT, companionHash: 'e'.repeat(64) });
    expect(withCompanion).not.toBe(golden.llmInputHash);
    // identical whether touched is undefined or []
    const withCompanionEmpty = computeLlmInputHash({ ...BASE_LLM_INPUT, companionHash: 'e'.repeat(64), touched: [] });
    expect(withCompanionEmpty).toBe(withCompanion);
  });

  it('editing companionHash changes the hash even with empty touched', () => {
    const a = computeLlmInputHash({ ...BASE_LLM_INPUT, companionHash: 'e'.repeat(64), touched: [] });
    const b = computeLlmInputHash({ ...BASE_LLM_INPUT, companionHash: 'f'.repeat(64), touched: [] });
    expect(a).not.toBe(b);
  });

  it('touched folds INDEPENDENT of companionHash: present touched + absent companionHash differs from plain', () => {
    const withTouched = computeLlmInputHash({ ...BASE_LLM_INPUT, touched: [['read:src/spec.ts', 'g'.repeat(64)]] });
    expect(withTouched).not.toBe(golden.llmInputHash);
  });

  it('touched fold is order-insensitive (sorted by key)', () => {
    const t1: Array<[string, string]> = [['read:a.ts', 'a'.repeat(64)], ['read:b.ts', 'b'.repeat(64)]];
    const t2: Array<[string, string]> = [['read:b.ts', 'b'.repeat(64)], ['read:a.ts', 'a'.repeat(64)]];
    expect(computeLlmInputHash({ ...BASE_LLM_INPUT, touched: t1 })).toBe(computeLlmInputHash({ ...BASE_LLM_INPUT, touched: t2 }));
  });
});

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

describe('computeDetInputHash', () => {
  const BASE_DET_INPUT: DetHashInput = {
    aspectId: 'no-direct-fs',
    scope: undefined,
    nodePath: 'billing/cancel',
    ruleHash: 'e'.repeat(64),
    files: [['src/billing/cancel.ts', 'f'.repeat(64)]],
    touched: [],
    verdict: 'approved',
  };

  it('det hash folds touched observations; input order of touched does not matter (sorted internally by key)', () => {
    const withTouched = computeDetInputHash({
      ...BASE_DET_INPUT,
      touched: [
        ['read:src/shared/codes.ts', 'g'.repeat(64)],
        ['list:src/billing', 'h'.repeat(64)],
      ],
    });
    const reversed = computeDetInputHash({
      ...BASE_DET_INPUT,
      touched: [
        ['list:src/billing', 'h'.repeat(64)],
        ['read:src/shared/codes.ts', 'g'.repeat(64)],
      ],
    });
    // Same content, different order → same hash
    expect(withTouched).toBe(reversed);

    // Different from empty touched
    const noTouched = computeDetInputHash({ ...BASE_DET_INPUT, touched: [] });
    expect(withTouched).not.toBe(noTouched);
  });

  it('det hash differs from LLM hash for same base ingredients (kind discriminator)', () => {
    const detHash = computeDetInputHash({
      aspectId: BASE_LLM_INPUT.aspectId,
      scope: BASE_LLM_INPUT.scope,
      nodePath: BASE_LLM_INPUT.nodePath,
      ruleHash: BASE_LLM_INPUT.ruleHash,
      files: BASE_LLM_INPUT.files,
      touched: [],
      verdict: BASE_LLM_INPUT.verdict,
    });
    expect(detHash).not.toBe(golden.llmInputHash);
  });
});

// ---------------------------------------------------------------------------
// observationKey
// ---------------------------------------------------------------------------

describe('observationKey encodings', () => {
  it('read prefix', () => {
    expect(observationKey('read', 'src/x.ts')).toBe('read:src/x.ts');
  });
  it('list prefix', () => {
    expect(observationKey('list', 'src/dir')).toBe('list:src/dir');
  });
  it('exists prefix', () => {
    expect(observationKey('exists', 'src/y.ts')).toBe('exists:src/y.ts');
  });
  it('graph prefix', () => {
    expect(observationKey('graph', 'billing/cancel')).toBe('graph:billing/cancel');
  });
});

// ---------------------------------------------------------------------------
// hashListObservation — golden pin
// ---------------------------------------------------------------------------

describe('hashListObservation', () => {
  it('hashListObservation = sha256 over sorted name:kind lines (golden)', () => {
    // BREAKING: this value is pinned in pair-hash-golden.json (spec §3.1 frozen contract).
    const unsorted = [
      { name: 'utils.ts', kind: 'file' as const },
      { name: 'types', kind: 'dir' as const },
      { name: 'cancel.ts', kind: 'file' as const },
    ];
    const sorted = [
      { name: 'cancel.ts', kind: 'file' as const },
      { name: 'types', kind: 'dir' as const },
      { name: 'utils.ts', kind: 'file' as const },
    ];
    const hashUnsorted = hashListObservation(unsorted);
    const hashSorted = hashListObservation(sorted);
    // Input order must not matter — sorted internally
    expect(hashUnsorted).toBe(hashSorted);
    // Golden pin
    expect(hashSorted).toBe(golden.hashListObservationGolden);
  });
});

// ---------------------------------------------------------------------------
// hashExistsObservation
// ---------------------------------------------------------------------------

describe('hashExistsObservation', () => {
  it('distinguishes file | dir | false', () => {
    const hashFile = hashExistsObservation('file');
    const hashDir = hashExistsObservation('dir');
    const hashFalse = hashExistsObservation(false);
    expect(hashFile).not.toBe(hashDir);
    expect(hashFile).not.toBe(hashFalse);
    expect(hashDir).not.toBe(hashFalse);
  });
});

// ---------------------------------------------------------------------------
// tierHashView
// ---------------------------------------------------------------------------

describe('tierHashView', () => {
  it('returns ONLY the tier name — no provider/consensus/config', () => {
    const view = tierHashView('standard');
    expect(view).toEqual({ name: 'standard' });
  });

  it('different names produce different views', () => {
    expect(tierHashView('fast')).not.toEqual(tierHashView('thorough'));
  });
});

// ---------------------------------------------------------------------------
// hashReadObservation
// ---------------------------------------------------------------------------

describe('hashReadObservation', () => {
  it('returns sha256 hex of buffer bytes', () => {
    const buf = Buffer.from('hello world');
    const hash = hashReadObservation(buf);
    // sha256('hello world') = b94d27b9934d3e08...
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same content, same hash
    expect(hashReadObservation(Buffer.from('hello world'))).toBe(hash);
    // Different content → different hash
    expect(hashReadObservation(Buffer.from('other'))).not.toBe(hash);
  });

  it('hashes raw bytes correctly for buffers containing bytes >= 0x80 (no latin1 round-trip corruption)', () => {
    // Bytes containing high-range values that would be corrupted by toString('binary')
    // followed by UTF-8 encoding (the old implementation path).
    const raw = Buffer.from([0x66, 0x6f, 0x6f, 0xc3, 0x28, 0xff]);
    // Compute expected digest independently — directly from the raw buffer.
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(hashReadObservation(raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// scope.files fold — determinism and identity
// ---------------------------------------------------------------------------

describe('scope.files fold', () => {
  const scopeWithFiles = {
    per: 'node' as const,
    files: { all_of: [{ path: 'src/**/*.ts' }, { not: { path: '**/*.test.ts' } }] },
  };

  it('is deterministic across calls with key-insertion-order-shuffled predicate objects', () => {
    // Build two predicate objects with the same logical content but different
    // key-insertion order to verify codePointCanonicalJson normalizes them.
    // Use a two-key atom ({ path, content }) so insertion order can actually differ.
    const scopeA = {
      per: 'node' as const,
      files: { all_of: [{ path: 'src/**/*.ts', content: 'register' }] },
    };
    const scopeB = {
      per: 'node' as const,
      // Same atom but keys inserted in reverse order: content first, then path.
      files: { all_of: [{ content: 'register', path: 'src/**/*.ts' }] },
    };
    // Non-vacuity guard: raw JSON.stringify preserves insertion order, so the
    // two objects must produce different raw strings before canonicalization.
    expect(JSON.stringify(scopeA.files)).not.toBe(JSON.stringify(scopeB.files));
    const hash1 = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: scopeA });
    const hash2 = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: scopeB });
    expect(hash1).toBe(hash2);
  });

  it('differs from the same input with no files filter', () => {
    const withFiles = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: scopeWithFiles });
    const noFiles = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: { per: 'node' } });
    expect(withFiles).not.toBe(noFiles);
  });

  it('codePointCanonicalJson of the predicate equals the pinned string', () => {
    const predicate = { all_of: [{ path: 'src/**/*.ts' }, { not: { path: '**/*.test.ts' } }] };
    expect(codePointCanonicalJson(predicate)).toBe(
      '{"all_of":[{"path":"src/**/*.ts"},{"not":{"path":"**/*.test.ts"}}]}',
    );
  });
});

// ---------------------------------------------------------------------------
// Virtual pairs — a file enforced by its architecture type alone, no owning
// component. `nodePath` is OPTIONAL on CommonHashInput; the ONLY change in this
// module — codePointCanonicalJson already drops undefined-valued keys
// (pre-existing behavior) and buildCommonCanonical already passes `input.nodePath`
// straight through, so omitting the owner needs no new logic, only the type.
// ---------------------------------------------------------------------------

describe('canonical form for a file enforced by its type alone', () => {
  it('omits the owning-component key entirely rather than writing a placeholder', () => {
    // A placeholder value would be a made-up identity that a real component
    // could later be given, and the two would then hash the same.
    const canonical = codePointCanonicalJson({
      aspect: 'a', files: [['src/x.ts', 'h']], node: undefined,
      rule: 'r', scope: { per: 'file' }, verdict: 'approved',
    });
    expect(canonical).not.toContain('"node"');
  });

  it('pins the stored fingerprints for both reviewer kinds', () => {
    const det = computeDetInputHash({
      aspectId: 'own-file-rule', scope: { per: 'file' }, ruleHash: 'r'.repeat(64),
      files: [['src/leaf/a.ts', 'f'.repeat(64)]], touched: [], verdict: 'approved',
    });
    const llm = computeLlmInputHash({
      aspectId: 'own-llm-rule', scope: { per: 'file' }, ruleHash: 'r'.repeat(64),
      files: [['src/leaf/a.ts', 'f'.repeat(64)]], verdict: 'approved',
      aspectDescription: 'd', references: [], tier: { name: 't' },
    });
    expect(det).toBe(golden.virtualDeterministic);
    expect(llm).toBe(golden.virtualLlm);
  });

  it('leaves every existing fingerprint untouched', () => {
    // The stored results of every component in every adopting repository depend
    // on this staying exactly as it is. The det side has no prior golden-JSON
    // entry (this is its first pin — added here as a literal, not a new JSON
    // key, since the golden file's own load-bearing invariant names only its
    // TWO pre-existing keys, llmInputHash and hashListObservationGolden, as
    // frozen).
    const EXISTING_DET_HASH = 'a4835a7dd9f9135bcbe2ad8bd63978dd471ab361fb6e7b8b46c47bcef1f8c919';
    expect(computeDetInputHash({
      aspectId: 'no-direct-fs', scope: undefined, nodePath: 'billing/cancel',
      ruleHash: 'e'.repeat(64), files: [['src/billing/cancel.ts', 'f'.repeat(64)]],
      touched: [], verdict: 'approved',
    })).toBe(EXISTING_DET_HASH);
    expect(computeLlmInputHash({ ...BASE_LLM_INPUT })).toBe(golden.llmInputHash);
  });
});

// ---------------------------------------------------------------------------
// references sort comparator
// ---------------------------------------------------------------------------

describe('references sort comparator', () => {
  it('unsorted references array hashes identically to sorted references array', () => {
    const ref1: [string, string, string] = ['docs/aaa-catalogue.md', 'd'.repeat(64), 'Catalogue A'];
    const ref2: [string, string, string] = ['docs/zzz-catalogue.md', 'e'.repeat(64), 'Catalogue Z'];

    const sortedHash = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      references: [ref1, ref2],
    });
    const unsortedHash = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      references: [ref2, ref1], // reversed insertion order
    });
    expect(unsortedHash).toBe(sortedHash);
  });

  it("reference description (3rd tuple element) folds into the hash", () => {
    const baseHash = computeLlmInputHash({ ...BASE_LLM_INPUT });
    const changedDescHash = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      references: [['docs/validation-catalogue.md', 'd'.repeat(64), 'Changed description']],
    });
    expect(changedDescHash).not.toBe(baseHash);
  });
});

// =============================================================================
// core/pair-inputs.ts — the shared verdict-hash INPUT ASSEMBLY helpers (rule
// content/hash, companion hash, node description, tier hash view) both the fill
// stage and the verify stage fold identically (spec §3.1). Colocated here
// because both modules implement the frozen input-hash contract this file pins.
// =============================================================================

function aspectWith(artifacts: Array<{ filename: string; content: string }>): AspectDef {
  return { id: 'a', name: 'a', description: 'a', reviewer: { type: 'llm' }, artifacts } as AspectDef;
}

describe('contentFor', () => {
  it('returns the text content of a present artifact', () => {
    const aspect = aspectWith([{ filename: 'content.md', content: '# Rule\nbody' }]);
    expect(contentFor(aspect, 'content.md')).toBe('# Rule\nbody');
  });

  it('returns "" when the named artifact is absent (e.g. check.mjs on an LLM-only aspect)', () => {
    const aspect = aspectWith([{ filename: 'content.md', content: '# Rule' }]);
    expect(contentFor(aspect, 'check.mjs')).toBe('');
  });
});

describe('ruleHashFor', () => {
  it('is the sha256 hex digest of the artifact bytes (contract #1)', () => {
    const aspect = aspectWith([{ filename: 'content.md', content: 'exact bytes' }]);
    const expected = createHash('sha256').update('exact bytes').digest('hex');
    expect(ruleHashFor(aspect, 'content.md')).toBe(expected);
  });

  it('hashes an absent artifact as the hash of the empty string (stable, not a crash)', () => {
    const aspect = aspectWith([]);
    const expected = createHash('sha256').update('').digest('hex');
    expect(ruleHashFor(aspect, 'content.md')).toBe(expected);
  });
});

describe('companionHashFor', () => {
  it('is undefined when the aspect ships no companion.mjs', () => {
    const aspect = aspectWith([{ filename: 'content.md', content: 'x' }]);
    expect(companionHashFor(aspect)).toBeUndefined();
  });

  it('is the sha256 hex digest of companion.mjs when present (even a []-resolving one)', () => {
    const aspect = aspectWith([
      { filename: 'content.md', content: 'x' },
      { filename: 'companion.mjs', content: 'export function companion() { return []; }' },
    ]);
    const expected = createHash('sha256')
      .update('export function companion() { return []; }')
      .digest('hex');
    expect(companionHashFor(aspect)).toBe(expected);
  });
});

describe('nodeDescriptionFor', () => {
  it("returns the node's description when the node exists", () => {
    const nodes = new Map([
      ['svc', { meta: { description: 'the svc node' } } as unknown as ReturnType<Graph['nodes']['get']>],
    ]) as Graph['nodes'];
    const graph = { nodes } as Graph;
    expect(nodeDescriptionFor(graph, 'svc')).toBe('the svc node');
  });

  it('returns "" when the node path is unknown', () => {
    const graph = { nodes: new Map() } as unknown as Graph;
    expect(nodeDescriptionFor(graph, 'nope')).toBe('');
  });
});

describe('tierHashViewFromTier', () => {
  it('folds ONLY the tier name — the resolved provider/model config is not a verdict input', () => {
    expect(tierHashViewFromTier('standard')).toEqual({ name: 'standard' });
  });
});
