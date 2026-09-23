import { describe, it, expect } from 'vitest';
import { resolveApproveMode, isCiEnvironment } from '../../../src/cli/check.js';
import type { YggConfig } from '../../../src/model/graph.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal YggConfig with only auto_approve set. */
function cfg(auto_approve: YggConfig['auto_approve']): YggConfig {
  return { auto_approve } as YggConfig;
}

// ── Matrix: config × opts ──────────────────────────────────────────────────

describe('resolveApproveMode', () => {
  // ── No explicit flag — drive from config ──────────────────────────────

  describe('no explicit approve flag — config drives decision', () => {
    it('config undefined → read-only', () => {
      expect(resolveApproveMode({}, undefined)).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config.auto_approve undefined → read-only', () => {
      expect(resolveApproveMode({}, cfg(undefined))).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config.auto_approve false → read-only', () => {
      expect(resolveApproveMode({}, cfg(false))).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config.auto_approve deterministic → approve:true, onlyDeterministic:true', () => {
      expect(resolveApproveMode({}, cfg('deterministic'))).toEqual({ approve: true, onlyDeterministic: true });
    });

    it('config.auto_approve full → approve:true, onlyDeterministic:false', () => {
      expect(resolveApproveMode({}, cfg('full'))).toEqual({ approve: true, onlyDeterministic: false });
    });
  });

  // ── Explicit --approve flag wins over config ───────────────────────────

  describe('--approve explicit → approve:true regardless of config', () => {
    it('config false + --approve → approve:true, onlyDeterministic:false', () => {
      expect(resolveApproveMode({ approve: true }, cfg(false))).toEqual({ approve: true, onlyDeterministic: false });
    });

    it('config undefined + --approve → approve:true', () => {
      expect(resolveApproveMode({ approve: true }, undefined)).toEqual({ approve: true, onlyDeterministic: false });
    });

    it('config full + --approve → approve:true (explicit beats config)', () => {
      expect(resolveApproveMode({ approve: true }, cfg('full'))).toEqual({ approve: true, onlyDeterministic: false });
    });

    it('config deterministic + --approve + no onlyDeterministic → full approve', () => {
      expect(resolveApproveMode({ approve: true }, cfg('deterministic'))).toEqual({ approve: true, onlyDeterministic: false });
    });

    it('--approve + --only-deterministic → approve:true, onlyDeterministic:true', () => {
      expect(resolveApproveMode({ approve: true, onlyDeterministic: true }, cfg(false))).toEqual({ approve: true, onlyDeterministic: true });
    });
  });

  // ── Explicit --no-approve wins over config ─────────────────────────────

  describe('--no-approve explicit → read-only regardless of config', () => {
    it('config full + --no-approve → read-only', () => {
      expect(resolveApproveMode({ approve: false }, cfg('full'))).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config deterministic + --no-approve → read-only', () => {
      expect(resolveApproveMode({ approve: false }, cfg('deterministic'))).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config undefined + --no-approve → read-only', () => {
      expect(resolveApproveMode({ approve: false }, undefined)).toEqual({ approve: false, onlyDeterministic: false });
    });
  });

  // ── --only-deterministic (without explicit --approve) ─────────────────

  describe('--only-deterministic implies approve:true', () => {
    it('config false + --only-deterministic → approve:true, onlyDeterministic:true', () => {
      expect(resolveApproveMode({ onlyDeterministic: true }, cfg(false))).toEqual({ approve: true, onlyDeterministic: true });
    });

    it('config undefined + --only-deterministic → approve:true, onlyDeterministic:true', () => {
      expect(resolveApproveMode({ onlyDeterministic: true }, undefined)).toEqual({ approve: true, onlyDeterministic: true });
    });

    it('config full + --only-deterministic → approve:true, onlyDeterministic:true (flag beats config)', () => {
      expect(resolveApproveMode({ onlyDeterministic: true }, cfg('full'))).toEqual({ approve: true, onlyDeterministic: true });
    });
  });

  // ── Completeness: the remaining config × flag combinations ────────────

  describe('resolveApproveMode — remaining config × flag combinations', () => {
    it('config full + --no-approve → approve:false', () => {
      expect(resolveApproveMode({ approve: false }, cfg('full'))).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config false + --only-deterministic → approve:true, onlyDeterministic:true', () => {
      expect(resolveApproveMode({ onlyDeterministic: true }, cfg(false))).toEqual({ approve: true, onlyDeterministic: true });
    });

    it('config deterministic + no flag → approve:true, onlyDeterministic:true', () => {
      expect(resolveApproveMode({}, cfg('deterministic'))).toEqual({ approve: true, onlyDeterministic: true });
    });

    it('config full + no flag → approve:true, onlyDeterministic:false', () => {
      expect(resolveApproveMode({}, cfg('full'))).toEqual({ approve: true, onlyDeterministic: false });
    });
  });

  // ── CI: a committed auto_approve: full must not turn the gate into a fill ──

  describe('under CI, config-driven full stays read-only', () => {
    const CI = { CI: 'true' };

    it('config full + no flag + CI=true → read-only (no reviewer call from config in CI)', () => {
      expect(resolveApproveMode({}, cfg('full'), CI)).toEqual({ approve: false, onlyDeterministic: false });
    });

    it('config full + explicit --approve + CI=true → still fills (explicit flag wins)', () => {
      expect(resolveApproveMode({ approve: true }, cfg('full'), CI)).toEqual({ approve: true, onlyDeterministic: false });
    });

    it('config deterministic + no flag + CI=true → deterministic fill kept (free, keyless, the CI cache rebuild)', () => {
      expect(resolveApproveMode({}, cfg('deterministic'), CI)).toEqual({ approve: true, onlyDeterministic: true });
    });

    it('config full + no flag + CI=false → fills as configured (CI switched off)', () => {
      expect(resolveApproveMode({}, cfg('full'), { CI: 'false' })).toEqual({ approve: true, onlyDeterministic: false });
    });

    it('isCiEnvironment reads CI: unset/empty/0/false are not CI; anything else is', () => {
      expect(isCiEnvironment({})).toBe(false);
      expect(isCiEnvironment({ CI: '' })).toBe(false);
      expect(isCiEnvironment({ CI: '0' })).toBe(false);
      expect(isCiEnvironment({ CI: 'FALSE' })).toBe(false);
      expect(isCiEnvironment({ CI: 'true' })).toBe(true);
      expect(isCiEnvironment({ CI: '1' })).toBe(true);
    });
  });
});
