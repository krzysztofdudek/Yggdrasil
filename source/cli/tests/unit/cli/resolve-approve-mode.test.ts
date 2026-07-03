import { describe, it, expect } from 'vitest';
import { resolveApproveMode } from '../../../src/cli/check.js';
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

  // ── Specific assertions from the brief ───────────────────────────────

  describe('brief-mandated assertions', () => {
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
});
