import { describe, it, expect } from 'vitest';
import {
  earlyCheckFlagRefusal,
  checkFlagCombinationRefusal,
  resolveCheckView,
  isTriageView,
  dryRunWithoutApproveRefusal,
} from '../../../src/cli/check-flags.js';

describe('check-flags — the yg check flag parse', () => {
  describe('earlyCheckFlagRefusal', () => {
    it('refuses --approve with --no-approve from the raw arguments, in either order', () => {
      expect(earlyCheckFlagRefusal({ approve: true }, ['node', 'yg', 'check', '--approve', '--no-approve'])?.what)
        .toBe('--approve cannot be combined with --no-approve.');
      expect(earlyCheckFlagRefusal({ approve: false }, ['node', 'yg', 'check', '--no-approve', '--approve'])?.what)
        .toBe('--approve cannot be combined with --no-approve.');
    });

    it('refuses --compact without --json, and accepts it with --json', () => {
      expect(earlyCheckFlagRefusal({ compact: true }, [])?.what).toBe('--compact requires --json.');
      expect(earlyCheckFlagRefusal({ compact: true, json: true }, [])).toBeNull();
    });

    it('checks the approve pair before --compact', () => {
      expect(earlyCheckFlagRefusal({ compact: true }, ['--approve', '--no-approve'])?.what)
        .toBe('--approve cannot be combined with --no-approve.');
    });

    it('accepts a plain run', () => {
      expect(earlyCheckFlagRefusal({}, ['node', 'yg', 'check'])).toBeNull();
    });
  });

  describe('checkFlagCombinationRefusal', () => {
    it('refuses each text view with --json, naming the view and its argument', () => {
      expect(checkFlagCombinationRefusal({ json: true, top: '3' })?.what).toBe('--top cannot be combined with --json.');
      expect(checkFlagCombinationRefusal({ json: true, top: '3' })?.next).toContain('yg check --top <n>');
      expect(checkFlagCombinationRefusal({ json: true, summary: true })?.what).toBe('--summary cannot be combined with --json.');
      expect(checkFlagCombinationRefusal({ json: true, details: true })?.what).toBe('--details cannot be combined with --json.');
      expect(checkFlagCombinationRefusal({ json: true, aspect: 'x' })?.next).toContain('yg check --aspect <id>');
    });

    it('refuses --coverage with --json', () => {
      expect(checkFlagCombinationRefusal({ json: true, coverage: true })?.what).toBe('--coverage cannot be combined with --json.');
    });

    it('refuses two views at once and a view with the writer', () => {
      expect(checkFlagCombinationRefusal({ top: true, summary: true })?.what).toBe('--top and --summary cannot be combined.');
      expect(checkFlagCombinationRefusal({ summary: true, approve: true })?.what).toBe('--summary cannot be combined with --approve.');
      expect(checkFlagCombinationRefusal({ details: true, top: '2' })?.what).toBe('--details cannot be combined with --top or --summary.');
      expect(checkFlagCombinationRefusal({ details: true, approve: true })?.what).toBe('--details cannot be combined with --approve.');
      expect(checkFlagCombinationRefusal({ aspect: 'x', approve: true })?.what).toBe('--aspect cannot be combined with --approve.');
      expect(checkFlagCombinationRefusal({ aspect: 'x', details: true })?.what).toBe('--aspect cannot be combined with --details.');
    });

    it('refuses a view with --only-deterministic before the view-pair refusals it would also break', () => {
      expect(checkFlagCombinationRefusal({ onlyDeterministic: true, details: true, top: '1' })?.what)
        .toBe('--top cannot be combined with --only-deterministic.');
    });

    it('refuses --no-approve with --only-deterministic', () => {
      expect(checkFlagCombinationRefusal({ approve: false, onlyDeterministic: true })?.what)
        .toBe('--no-approve cannot be combined with --only-deterministic.');
    });

    it('refuses --json combinations first when several rules are broken', () => {
      expect(checkFlagCombinationRefusal({ json: true, top: true, summary: true, approve: true })?.what)
        .toBe('--top cannot be combined with --json.');
    });

    it('accepts every flag set that breaks no rule', () => {
      expect(checkFlagCombinationRefusal({})).toBeNull();
      expect(checkFlagCombinationRefusal({ approve: true, coverage: true })).toBeNull();
      expect(checkFlagCombinationRefusal({ json: true, approve: true, dryRun: true })).toBeNull();
      expect(checkFlagCombinationRefusal({ aspect: 'x', coverage: true })).toBeNull();
    });
  });

  describe('resolveCheckView', () => {
    it('picks the view in the fixed order aspect, details, summary, top, full', () => {
      expect(resolveCheckView({ aspect: 'a' })).toEqual({ view: { kind: 'aspect', id: 'a' } });
      expect(resolveCheckView({ details: true })).toEqual({ view: { kind: 'details' } });
      expect(resolveCheckView({ summary: true })).toEqual({ view: { kind: 'summary', by: 'codes' } });
      expect(resolveCheckView({ summary: 'nodes' })).toEqual({ view: { kind: 'summary', by: 'nodes' } });
      expect(resolveCheckView({ top: true })).toEqual({ view: { kind: 'top', n: 1 } });
      expect(resolveCheckView({ top: '5' })).toEqual({ view: { kind: 'top', n: 5 } });
      expect(resolveCheckView({})).toEqual({ view: { kind: 'full' } });
    });

    it('refuses a --summary argument other than nodes, and a --top that is not a positive whole number', () => {
      const summary = resolveCheckView({ summary: 'files' });
      expect('refusal' in summary && summary.refusal.what).toBe(`--summary takes 'nodes' or nothing; got "files".`);
      for (const top of ['0', '-1', '2.5', 'many']) {
        const view = resolveCheckView({ top });
        expect('refusal' in view && view.refusal.what).toBe(`--top expects a positive whole number (1 or more); got "${top}".`);
      }
    });
  });

  it('isTriageView is true for exactly the four read-only views', () => {
    expect(isTriageView({})).toBe(false);
    expect(isTriageView({ approve: true, coverage: true, json: true })).toBe(false);
    expect(isTriageView({ top: true })).toBe(true);
    expect(isTriageView({ summary: true })).toBe(true);
    expect(isTriageView({ details: true })).toBe(true);
    expect(isTriageView({ aspect: 'x' })).toBe(true);
  });

  it('dryRunWithoutApproveRefusal names the free read the project actually has', () => {
    expect(dryRunWithoutApproveRefusal(undefined).next).toBe('Run: yg check --approve --dry-run (cost preview), or yg check (plain read).');
    expect(dryRunWithoutApproveRefusal(false).next).toBe('Run: yg check --approve --dry-run (cost preview), or yg check (plain read).');
    const auto = dryRunWithoutApproveRefusal('full');
    expect(auto.next).toBe('Run: yg check --approve --dry-run (cost preview), or yg check --no-approve (plain read).');
    expect(auto.why).toContain('This project sets auto_approve: full');
  });
});
