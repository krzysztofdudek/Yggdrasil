import { describe, it, expect } from 'vitest';
import { closestKnownKey, describeUnknownKeys, editDistance, findUnknownKeys } from '../../../src/utils/known-keys.js';

describe('known-keys — the shared reading of a key a block does not accept', () => {
  it('counts an insertion, a deletion, a substitution and an adjacent swap as one edit each', () => {
    expect(editDistance('relation', 'relations')).toBe(1);
    expect(editDistance('aspects', 'aspect')).toBe(1);
    expect(editDistance('modle', 'model')).toBe(1);
    expect(editDistance('stauts', 'status')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('suggests the nearest accepted key only when it is plausibly a typo', () => {
    const known = ['name', 'type', 'relations', 'aspects', 'status'];
    expect(closestKnownKey('relation', known)).toBe('relations');
    expect(closestKnownKey('Relations', known)).toBe('relations');
    expect(closestKnownKey('stauts', known)).toBe('status');
    expect(closestKnownKey('bogus_key', known)).toBeUndefined();
  });

  it('finds every unknown key in file order, a retired one named as retired rather than guessed at', () => {
    const found = findUnknownKeys(
      { name: 'x', relation: [], sizeExempt: { reason: 'r' }, bogus_key: 1 },
      ['name', 'relations'],
      { sizeExempt: 'removed in 5.0.0' },
    );
    expect(found).toEqual([
      { key: 'relation', suggestion: 'relations' },
      { key: 'sizeExempt', retired: 'removed in 5.0.0' },
      { key: 'bogus_key' },
    ]);
  });

  it('describes the keys with their did-you-mean, why they are refused, and what is accepted', () => {
    const text = describeUnknownKeys(
      'relations[0]',
      [{ key: 'targt', suggestion: 'target' }, { key: 'old', retired: 'removed in 5.0.0' }],
      ['target', 'type'],
    );
    expect(text).toContain("unknown keys 'targt' (did you mean 'target'?), 'old' (removed in 5.0.0 — delete it) in relations[0].");
    expect(text).toContain('would silently not be in effect');
    expect(text).toContain('Accepted keys: target, type.');
    expect(describeUnknownKeys('', [{ key: 'x' }], ['a'])).toMatch(/^unknown key 'x'\. /);
  });
});
