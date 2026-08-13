import { describe, it, expect } from 'vitest';
import {
  SCOPED_CODES,
  OUTSIDE_CODES,
  outsideTwin,
  STRUCTURAL_CODES,
  APPROVE_GATING_CODES,
  SINGLETON_INPUTS,
} from '../../../src/core/check-codes.js';

// The exact four STRUCTURAL_CODES members allowed to double as SCOPED_CODES
// members. This is policy, not a derivable fact — asserted as a literal set so
// a future edit that swaps one carve-out for another (rather than adding a
// documented fifth) fails loudly instead of silently changing what "code a
// change is not accountable for" means.
const CARVE_OUT_CODES = new Set<string>([
  'type-when-mismatch',
  'relation-undeclared-dependency',
  'type-relation-forbidden',
  'ambiguous-node-type',
]);

describe('SCOPED_CODES partition', () => {
  it('every member is either outside STRUCTURAL_CODES or one of the four named carve-outs', () => {
    for (const code of SCOPED_CODES) {
      const inStructural = STRUCTURAL_CODES.has(code);
      expect(inStructural ? CARVE_OUT_CODES.has(code) : true).toBe(true);
    }
  });

  it('contains exactly the four named carve-outs, and no other STRUCTURAL_CODES member', () => {
    const structuralMembersOfScoped = [...SCOPED_CODES].filter((code) => STRUCTURAL_CODES.has(code));
    expect(new Set(structuralMembersOfScoped)).toEqual(CARVE_OUT_CODES);
  });

  it('each carve-out is individually present in both SCOPED_CODES and STRUCTURAL_CODES', () => {
    for (const code of CARVE_OUT_CODES) {
      expect(STRUCTURAL_CODES.has(code)).toBe(true);
      expect(SCOPED_CODES.has(code)).toBe(true);
    }
  });

  it('the three non-carve-out type codes are genuinely NOT structural members', () => {
    for (const code of ['type-strict-orphan', 'type-strict-misplaced', 'strict-overlap-conflict']) {
      expect(STRUCTURAL_CODES.has(code)).toBe(false);
      expect(SCOPED_CODES.has(code)).toBe(true);
    }
  });

  it('never overlaps APPROVE_GATING_CODES — a fill-abort reason can never be a downgrade candidate', () => {
    for (const code of SCOPED_CODES) {
      expect(APPROVE_GATING_CODES.has(code)).toBe(false);
    }
  });

  it('excludes codes that must always block unconditionally, independent of a change', () => {
    for (const code of ['lock-invalid', 'file-unreadable', 'relation-parse-failed', 'file-mapping-excluded']) {
      expect(SCOPED_CODES.has(code)).toBe(false);
    }
  });
});

describe('outsideTwin', () => {
  it('appends the -outside suffix', () => {
    expect(outsideTwin('unverified')).toBe('unverified-outside');
  });

  it('round-trips: stripping the suffix it appended recovers the original code', () => {
    for (const code of SCOPED_CODES) {
      const twin = outsideTwin(code);
      expect(twin.endsWith('-outside')).toBe(true);
      expect(twin.slice(0, -'-outside'.length)).toBe(code);
    }
  });

  it('is the only spelling of the suffix: OUTSIDE_CODES is exactly {outsideTwin(c) for c in SCOPED_CODES}', () => {
    const expected = new Set([...SCOPED_CODES].map(outsideTwin));
    expect(OUTSIDE_CODES).toEqual(expected);
    expect(OUTSIDE_CODES.size).toBe(SCOPED_CODES.size);
  });
});

describe('OUTSIDE_CODES', () => {
  it('never collides with STRUCTURAL_CODES — an -outside twin can never be mistaken for a real structural code', () => {
    for (const code of OUTSIDE_CODES) {
      expect(STRUCTURAL_CODES.has(code)).toBe(false);
    }
  });
});

describe('SINGLETON_INPUTS', () => {
  it('maps exactly the four fixed-file singleton codes to their real input paths', () => {
    expect(SINGLETON_INPUTS.get('rules-digest-stale')).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      '.clinerules/yggdrasil.md',
    ]);
    expect(SINGLETON_INPUTS.get('incident-ledger-out-of-order')).toEqual(['.yggdrasil/incidents.md']);
    expect(SINGLETON_INPUTS.get('coverage-required-shadowed')).toEqual(['yg-config.yaml']);
    expect(SINGLETON_INPUTS.get('type-unknown-parent')).toEqual(['yg-architecture.yaml']);
    expect(SINGLETON_INPUTS.size).toBe(4);
  });

  it('every entry has at least one path, and no path is blank or padded', () => {
    for (const [code, paths] of SINGLETON_INPUTS) {
      expect(paths.length, `${code} must name at least one input path`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p.length).toBeGreaterThan(0);
        expect(p.trim()).toBe(p);
      }
    }
  });

  it('none of the singleton codes are members of SCOPED_CODES — their finding is never about the change\'s own diff', () => {
    for (const code of SINGLETON_INPUTS.keys()) {
      expect(SCOPED_CODES.has(code)).toBe(false);
    }
  });
});
