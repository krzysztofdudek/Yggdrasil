import { describe, it, expect } from 'vitest';
import { formatFileContextBrief, formatFileContextAspect, formatFileContext, effectiveAspects } from '../../../src/formatters/context-file.js';
import type { FileContextData, FileBriefExtras } from '../../../src/formatters/context-file.js';

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
  it('renders two lines per aspect: [status] id — first sentence, then its read path', () => {
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

  it('omits the scope suffix for a draft rule in the compact view too, while a sibling non-draft rule still gets one', () => {
    const withDraft = { ...base, aspects: [{ ...base.aspects[0], status: 'draft' as const }, base.aspects[1]] };
    const out = formatFileContextBrief(withDraft, {
      nextPointers: [],
      scopeByAspect: new Map([['what-why-next', 'inherited'], ['no-direct-db', 'inherited']]),
    });
    const draftLine = out.split('\n').find((l) => l.includes('what-why-next'))!;
    expect(draftLine).not.toMatch(/\(yours\)|\(inherited\)/);
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

  it('pins the exact worst-case line count at the aspect cap plus truncation tail, with every extra present', () => {
    // The renderer owns the budget the option help advertises ("≤ 30 lines"),
    // so the pin lives here rather than at a CLI call site. TEST-LOCAL
    // constants only — BRIEF_ASPECT_CAP stays unexported so the formatter's
    // budget shape cannot silently change without a test noticing; a future
    // line added to formatFileContextBrief throws the exact-equality
    // assertion below off by name.
    const CAP = 8; // matches the formatter's private BRIEF_ASPECT_CAP
    const LINES_PER_RULE = 2; // "[status] id — desc" + "read: ..." (or the draft note)
    const PATH_LINE = 1;
    const OWNER_LINE = 1;
    const SCOPE_HEADER_LINE = 1;
    const MUST_SATISFY_HEADER_LINE = 1;
    const TRUNCATION_TAIL_LINE = 1; // present because the aspect count exceeds CAP
    const ARM_PREVIEW_LINE = 1;
    const DEPENDS_ON_LINE = 1; // one line regardless of overflow — the list is always capped at 3 + a marker
    const DEPENDENTS_LINE = 1;
    const LOG_GATE_LINE = 1;
    const FLOWS_LINE = 1;
    const NEXT_POINTER_LINES = 3; // capped at 3 by the renderer

    // path 1 + owner 1 + scope 1 + must-satisfy 1 + 16 + tail 1 + arm 1 + depends 1 +
    // dependents 1 + log 1 + flows 1 + next 3 = 29
    const expectedTotal =
      PATH_LINE + OWNER_LINE + SCOPE_HEADER_LINE + MUST_SATISFY_HEADER_LINE +
      CAP * LINES_PER_RULE + TRUNCATION_TAIL_LINE + ARM_PREVIEW_LINE +
      DEPENDS_ON_LINE + DEPENDENTS_LINE + LOG_GATE_LINE + FLOWS_LINE + NEXT_POINTER_LINES;
    expect(expectedTotal).toBe(29);

    // CAP + 1 aspects: the cap renders, the tail line reports the rest.
    const nine: FileContextData = {
      ...base,
      aspects: Array.from({ length: CAP + 1 }, (_, i) => ({
        aspectId: `rule-${i}`,
        aspectDescription: `Rule ${i} does a thing.`,
        verifiedAgainst: `.yggdrasil/aspects/rule-${i}/check.mjs`,
        status: 'enforced' as const,
      })),
      // 4+ dependencies triggers the overflow marker but still renders as one line.
      dependencies: [
        { path: 'src/a.ts', consumed: ['calls'] },
        { path: 'src/b.ts', consumed: ['calls'] },
        { path: 'src/c.ts', consumed: ['calls'] },
        { path: 'src/d.ts', consumed: ['calls'] },
      ],
      dependentCount: 3,
    };
    const extras: FileBriefExtras = {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map(nine.aspects.map((a) => [a.aspectId, 'yours' as const])),
      logGateText: 'Log entry required before approve: no (fresh entry present: no)',
      flowsText: 'Flows: checkout',
      nextPointers: ['next: a', 'next: b', 'next: c'],
    };

    const rendered = formatFileContextBrief(nine, extras);
    expect(rendered.trimEnd().split('\n').length).toBe(expectedTotal);

    // Restated in the CLI's own terms, matching the option help's "≤ 30 lines"
    // exactly: the node-owned --brief path prints one extra stdout line ahead
    // of the renderer's own output. This is implied by the assertion above,
    // not an independent guard — it exists only so a reader can match the
    // renderer's total to the CLI-level claim without re-deriving it.
    expect(rendered.trimEnd().split('\n').length + 1).toBe(30);
  });

  it('renders the type-covered variant with the same two-line-per-aspect shape', () => {
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

  it('caps the dependency list at 3 with an overflow marker', () => {
    const many = { ...base, dependencies: [
      { path: 'src/a.ts', consumed: ['calls'] },
      { path: 'src/b.ts', consumed: ['calls'] },
      { path: 'src/c.ts', consumed: ['calls'] },
      { path: 'src/d.ts', consumed: ['calls'] },
      { path: 'src/e.ts', consumed: ['calls'] },
    ] };
    const out = formatFileContextBrief(many, { nextPointers: [] });
    expect(out).toContain('  Depends on: src/a.ts · src/b.ts · src/c.ts · …');
    expect(out).not.toContain('src/d.ts');
  });

  it('an unmapped file with no candidates omits the candidate line', () => {
    const un: FileContextData = { filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0 };
    const out = formatFileContextBrief(un, { nextPointers: [] });
    expect(out).toContain('  Owner: unmapped');
    expect(out).not.toContain('Candidate nodes:');
  });

  it('falls back to enforced status when an aspect omits it', () => {
    const noStatus = { ...base, aspects: [{ aspectId: 'what-why-next', aspectDescription: base.aspects[0].aspectDescription, verifiedAgainst: base.aspects[0].verifiedAgainst }] };
    const out = formatFileContextBrief(noStatus, { nextPointers: [] });
    const line = out.split('\n').find((l) => l.includes('what-why-next'))!;
    expect(line.startsWith('  [enforced] ')).toBe(true);
  });

  it('falls back to unknown owner type when ownerType is omitted', () => {
    const noType = { ...base, ownerPath: 'model/cli/formatters', ownerType: undefined };
    const out = formatFileContextBrief(noType, { nextPointers: [] });
    expect(out).toMatch(/^ {2}Owner: model\/cli\/formatters \(unknown\)$/m);
  });
});

describe('formatFileContext — scope suffixes', () => {
  it('appends scope suffixes at the full-view aspect-header line', () => {
    const scopeByAspect = new Map<string, 'yours' | 'inherited'>([
      [base.aspects[0].aspectId, 'yours'],
      [base.aspects[1].aspectId, 'inherited'],
    ]);
    const out = formatFileContext(base, scopeByAspect);
    expect(out).toMatch(/what-why-next.*\(yours\)/);
    expect(out).toMatch(/no-direct-db.*\(inherited\)/);
  });

  it('appends scope suffixes at the type-covered aspect-header line', () => {
    const tc: FileContextData = { filePath: 'src/lib/util.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'library', chainTerminationText: 'Inherited rules stop at the type.',
        applied: [{ aspectId: 'pure-fn', aspectDescription: 'Library files export pure functions.', verifiedAgainst: '.yggdrasil/aspects/pure-fn/check.mjs', status: 'enforced', unverified: true }],
        dropped: [] } };
    const scopeByAspect = new Map<string, 'yours' | 'inherited'>([['pure-fn', 'yours']]);
    const out = formatFileContext(tc, scopeByAspect);
    expect(out).toMatch(/pure-fn.*\[enforced, unverified\].*\(yours\)/);
  });

  it('omits the scope suffix for a draft rule while a sibling non-draft rule still gets one', () => {
    const withDraft: FileContextData = {
      ...base,
      aspects: [{ ...base.aspects[0], status: 'draft' }, base.aspects[1]],
    };
    const scopeByAspect = new Map<string, 'yours' | 'inherited'>([
      [withDraft.aspects[0].aspectId, 'inherited'],
      [withDraft.aspects[1].aspectId, 'inherited'],
    ]);
    const out = formatFileContext(withDraft, scopeByAspect);
    const draftLine = out.split('\n').find((l) => l.includes('what-why-next'))!;
    expect(draftLine).not.toMatch(/\(yours\)|\(inherited\)/);
    expect(out).toMatch(/no-direct-db.*\(inherited\)/);
  });
});

describe('formatFileContextAspect', () => {
  const withRefs: FileContextData = {
    ...base,
    aspects: [{
      aspectId: 'what-why-next',
      aspectDescription: 'Diagnostics use the shared builder. Second sentence is kept here.',
      verifiedAgainst: '.yggdrasil/aspects/what-why-next/content.md',
      status: 'enforced',
      references: [{ path: 'src/formatters/message-builder.ts', description: 'The builder itself.' }],
      companionReadPath: '.yggdrasil/aspects/what-why-next/companion.mjs',
    }],
  };

  it('keeps the whole description a compact line would truncate, and every read path', () => {
    const out = formatFileContextAspect(withRefs, 'what-why-next')!;
    expect(out).toContain('Second sentence is kept here.');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/content.md');
    expect(out).toContain('read: src/formatters/message-builder.ts — The builder itself.');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/companion.mjs');
  });

  it('returns undefined for a rule this file does not carry', () => {
    expect(formatFileContextAspect(withRefs, 'no-such-rule')).toBeUndefined();
  });

  it('finds a rule on a type-covered file too', () => {
    const tc: FileContextData = { filePath: 'src/lib/util.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'library', chainTerminationText: 'stops here.',
        applied: [{ aspectId: 'pure-fn', aspectDescription: 'Library files export pure functions.', verifiedAgainst: '.yggdrasil/aspects/pure-fn/check.mjs', status: 'enforced', unverified: true }],
        dropped: [] } };
    expect(formatFileContextAspect(tc, 'pure-fn')).toContain('[enforced, unverified]');
  });

  it('stops after the description for a draft rule, with no read line at all', () => {
    const draft: FileContextData = {
      ...base,
      aspects: [{ ...base.aspects[0], status: 'draft' }],
    };
    const out = formatFileContextAspect(draft, 'what-why-next')!;
    expect(out).toContain('what-why-next [draft]');
    expect(out).toContain(base.aspects[0].aspectDescription);
    expect(out).toContain('    (reviewer skipped; aspect is draft)');
    expect(out).not.toContain('read:');
  });

  it('returns undefined when the file has neither an owner nor type coverage', () => {
    const orphan: FileContextData = { filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0 };
    expect(formatFileContextAspect(orphan, 'anything')).toBeUndefined();
  });

  it('falls back to enforced status when the aspect omits it', () => {
    const noStatus: FileContextData = {
      ...base,
      aspects: [{ aspectId: 'what-why-next', aspectDescription: base.aspects[0].aspectDescription, verifiedAgainst: base.aspects[0].verifiedAgainst }],
    };
    const out = formatFileContextAspect(noStatus, 'what-why-next')!;
    expect(out.startsWith('what-why-next [enforced]')).toBe(true);
  });

  it('renders a bare read line when a reference has no description', () => {
    const noDesc: FileContextData = {
      ...base,
      aspects: [{
        ...withRefs.aspects[0],
        references: [{ path: 'src/formatters/message-builder.ts' }],
      }],
    };
    const out = formatFileContextAspect(noDesc, 'what-why-next')!;
    const line = out.split('\n').find((l) => l.includes('message-builder.ts'))!;
    expect(line).toBe('read: src/formatters/message-builder.ts');
  });
});

describe('effectiveAspects', () => {
  it('is the single source for "which rules govern this file" across owner kinds', () => {
    const owned = { ...base };
    expect(effectiveAspects(owned)).toBe(owned.aspects);
    const typeCovered: FileContextData = {
      filePath: 'src/leaf/a.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'leaf', applied: base.aspects, chainTerminationText: 'Inherited rules stop at the type.', dropped: [] },
    };
    expect(effectiveAspects(typeCovered)).toBe(base.aspects);
    const unmapped: FileContextData = {
      filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0,
    };
    expect(effectiveAspects(unmapped)).toEqual([]);
  });
});
