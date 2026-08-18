import { describe, it, expect } from 'vitest';
import { formatFileContextBrief } from '../../../src/formatters/context-file.js';
import type { FileContextData } from '../../../src/formatters/context-file.js';

const base: FileContextData = {
  filePath: 'src/app/handler.ts',
  ownerPath: 'app/handler',
  ownerType: 'command',
  aspects: [
    { aspectId: 'what-why-next', aspectDescription: 'Diagnostics use the shared builder. Second sentence is dropped.', verifiedAgainst: '.yggdrasil/aspects/what-why-next/content.md', status: 'enforced' },
    { aspectId: 'no-direct-db', aspectDescription: 'Handlers never reach the data store directly.', verifiedAgainst: '.yggdrasil/aspects/no-direct-db/check.mjs', status: 'advisory' },
  ],
  dependencies: [{ path: 'core/db', consumed: ['calls'] }],
  dependentCount: 3,
};

/** Eight aspects — the cap — so the line budget is asserted where it is tightest. */
const eight: FileContextData = {
  ...base,
  aspects: Array.from({ length: 8 }, (_, i) => ({
    aspectId: `rule-${i}`,
    aspectDescription: `Rule ${i} does a thing.`,
    verifiedAgainst: `.yggdrasil/aspects/rule-${i}/check.mjs`,
    status: 'enforced' as const,
  })),
};

describe('formatFileContextBrief', () => {
  it('renders one line per aspect: [status] id — first sentence, then its read path', () => {
    const out = formatFileContextBrief(base, { nextPointers: [] });
    expect(out).toContain('src/app/handler.ts');
    expect(out).toContain('Owner: app/handler (command)');
    expect(out).toContain('[enforced] what-why-next — Diagnostics use the shared builder.');
    expect(out).not.toContain('Second sentence');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/content.md');
    expect(out).toContain('[advisory] no-direct-db — Handlers never reach the data store directly.');
  });

  it('caps a long single sentence with the same 80-char helper the full view uses', () => {
    const long = { ...base, aspects: [{ ...base.aspects[0], aspectDescription: 'A'.repeat(200) }] };
    const line = formatFileContextBrief(long, { nextPointers: [] })
      .split('\n')
      .find((l) => l.includes('what-why-next'))!;
    expect(line.endsWith('...')).toBe(true);
    expect(line.length).toBeLessThan(140);
  });

  it('names a draft rule without offering a read path, exactly as the full view refuses to', () => {
    const draft = { ...base, aspects: [{ ...base.aspects[0], status: 'draft' as const }] };
    const out = formatFileContextBrief(draft, { nextPointers: [] });
    expect(out).toContain('[draft] what-why-next —');
    expect(out).toContain('(reviewer skipped; aspect is draft)');
    expect(out).not.toContain('read: .yggdrasil/aspects/what-why-next/content.md');
  });

  it('appends scope suffixes and the scope header when the change was measured', () => {
    const out = formatFileContextBrief(base, {
      nextPointers: [],
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map([['what-why-next', 'yours'], ['no-direct-db', 'inherited']]),
    });
    expect(out).toContain('your change so far: 2 files; this file is in it');
    expect(out).toMatch(/what-why-next.*\(yours\)/);
    expect(out).toMatch(/no-direct-db.*\(inherited\)/);
  });

  it('renders the arm preview, the log-gate and flows lines, and the next pointers in order', () => {
    const out = formatFileContextBrief(base, {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      logGateText: 'Log entry required before approve: yes (fresh entry present: no)',
      flowsText: 'Flows: checkout · refund',
      nextPointers: ['next: yg log read --node app/handler', 'next: yg context --node app', 'next: yg context --file src/app/handler.ts --aspect no-direct-db'],
    });
    expect(out).toContain('invalidates 4 pairs (3 free / 1 reviewer pair)');
    expect(out).toContain('Log entry required before approve: yes (fresh entry present: no)');
    expect(out).toContain('Flows: checkout · refund');
    const idx = out.indexOf('next: yg log read');
    expect(idx).toBeGreaterThan(-1);
    expect(out.indexOf('next: yg context --node app')).toBeGreaterThan(idx);
  });

  it('truncates beyond 8 aspects with an honest tail line', () => {
    const many = { ...base, aspects: Array.from({ length: 11 }, (_, i) => ({
      aspectId: `rule-${i}`, aspectDescription: `Rule ${i} does a thing.`,
      verifiedAgainst: `.yggdrasil/aspects/rule-${i}/check.mjs`,
      status: 'enforced' as const })) };
    const out = formatFileContextBrief(many, { nextPointers: [] });
    expect(out).toContain('rule-7');
    expect(out).not.toContain('rule-8');
    expect(out).toContain('… and 3 more — run yg context --file src/app/handler.ts for all');
  });

  it('stays within 30 lines at the aspect cap with every extra present', () => {
    const out = formatFileContextBrief(eight, {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map(eight.aspects.map((a) => [a.aspectId, 'yours' as const])),
      logGateText: 'Log entry required before approve: no (fresh entry present: no)',
      flowsText: 'Flows: checkout',
      nextPointers: ['next: a', 'next: b', 'next: c'],
    });
    expect(out.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
  });

  it('renders the type-covered variant with the same one-line-per-aspect shape', () => {
    const tc: FileContextData = { filePath: 'src/lib/util.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'library', chainTerminationText: 'Inherited rules stop at the type.',
        applied: [{ aspectId: 'pure-fn', aspectDescription: 'Library files export pure functions.', verifiedAgainst: '.yggdrasil/aspects/pure-fn/check.mjs', status: 'enforced', unverified: true }],
        dropped: [] } };
    const out = formatFileContextBrief(tc, { nextPointers: [] });
    expect(out).toContain('Owner: type:library');
    expect(out).toContain('[enforced, unverified] pure-fn — Library files export pure functions.');
  });

  it('an unmapped file says so and still offers its candidate nodes', () => {
    const un: FileContextData = { filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0,
      candidates: [{ nodePath: 'app', mappingPrefix: 'src/app' }, { nodePath: 'lib', mappingPrefix: 'src/lib' }] };
    const out = formatFileContextBrief(un, { nextPointers: [] });
    expect(out).toContain('Owner: unmapped');
    expect(out).toContain('Candidate nodes: app · lib');
  });
});
