import { describe, it, expect } from 'vitest';
import {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
} from '../../../src/core/check.js';
import {
  blockingUnmappedPaths,
  isExcludedByCoverage,
  checkRequiredShadowedByExcluded,
} from '../../../src/core/check-coverage-tiers.js';

// The question `yg init` asks after writing the agent-rules files into a
// project: will THIS project's coverage settings turn them red? Answered
// against the same primitives the check uses, so the prediction cannot drift
// from the gate it predicts.
describe('blockingUnmappedPaths', () => {
  const MANAGED = ['AGENTS.md', 'CLAUDE.md', '.clinerules/yggdrasil.md', '.gitattributes'];

  it('whole-repo required with nothing mapped → every managed file blocks', () => {
    expect(blockingUnmappedPaths(MANAGED, [], { required: ['/'], excluded: [], typeLevel: false })).toEqual(MANAGED);
  });

  it('excluded roots silence them, directory form included', () => {
    const coverage = { required: ['/'], excluded: ['AGENTS.md', 'CLAUDE.md', '.clinerules/', '.gitattributes'], typeLevel: false };
    expect(blockingUnmappedPaths(MANAGED, [], coverage)).toEqual([]);
  });

  it('a node mapping over them counts as covered, exactly as the check sees it', () => {
    const mappings = ['AGENTS.md', 'CLAUDE.md', '.clinerules/', '.gitattributes'];
    expect(blockingUnmappedPaths(MANAGED, mappings, { required: ['/'], excluded: [], typeLevel: false })).toEqual([]);
  });

  it('require-nothing coverage blocks none of them', () => {
    expect(blockingUnmappedPaths(MANAGED, [], { required: [], excluded: [], typeLevel: false })).toEqual([]);
  });

  it('required roots that do not reach the repo root leave them non-blocking', () => {
    expect(blockingUnmappedPaths(MANAGED, [], { required: ['src/'], excluded: [], typeLevel: false })).toEqual([]);
  });

  it('reports only the files that are actually still unmapped', () => {
    const blocked = blockingUnmappedPaths(MANAGED, ['AGENTS.md'], { required: ['/'], excluded: ['.gitattributes'], typeLevel: false });
    expect(blocked).toEqual(['CLAUDE.md', '.clinerules/yggdrasil.md']);
  });

  it('tolerates mapping entries in the forms a node file may carry', () => {
    // Trailing slash, leading ./ — normalized the same way node mappings are.
    const mappings = ['./AGENTS.md', '.clinerules/', '', 'CLAUDE.md', '.gitattributes'];
    expect(blockingUnmappedPaths(MANAGED, mappings, { required: ['/'], excluded: [], typeLevel: false })).toEqual([]);
  });

  it('a nested config now silences a file blockingUnmappedPaths used to flag — yg init advice shifts for free (no code change in blockingUnmappedPaths itself)', () => {
    // Before: required '.clinerules/' (more specific, wins) made this file blocking.
    // After: excluded '.clinerules' (broader ancestor, now always wins) silences it outright.
    const coverage = { required: ['.clinerules/yggdrasil.md'], excluded: ['.clinerules/'], typeLevel: false };
    expect(blockingUnmappedPaths(['.clinerules/yggdrasil.md'], [], coverage)).toEqual([]);
  });
});

describe('buildCoverageIssue', () => {
  it('returns null when nothing is uncovered', () => {
    expect(buildCoverageIssue([], 10)).toBeNull();
  });

  it('small count (<= 5): lists the files directly, singular/plural correct', () => {
    const one = buildCoverageIssue(['src/a.ts'], 10);
    expect(one!.code).toBe('unmapped-files');
    expect(one!.messageData.what).toContain('1 source file not covered');
    expect(one!.messageData.what).toContain('src/a.ts');
    const few = buildCoverageIssue(['src/a.ts', 'src/b.ts'], 10);
    expect(few!.messageData.what).toContain('2 source files not covered');
  });

  it('large count (> 5) with LOW coverage (<50%) gives the cold-start guidance', () => {
    const many = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const issue = buildCoverageIssue(many, 10); // 2/10 covered → 20% < 50%
    expect(issue!.messageData.what).toContain('8 source files have no graph coverage');
    expect(issue!.messageData.what).toContain('... and 3 more'); // 8 - 5 sample
    expect(issue!.messageData.next).toContain('Establish coverage');
  });

  it('large count (> 5) with HIGH coverage (>=50%) gives the incremental guidance', () => {
    const many = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const issue = buildCoverageIssue(many, 100); // 94/100 covered → high
    expect(issue!.messageData.next).toContain('existing node mapping');
  });

  it('treats a zero-file git listing as 100% coverage (no division by zero)', () => {
    // totalGitFiles === 0 → coveragePct falls back to 100, which (since 100 is not
    // < 50) must select the incremental guidance, not the cold-start one.
    const many = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const issue = buildCoverageIssue(many, 0);
    expect(issue!.messageData.next).toContain('existing node mapping');
    expect(issue!.messageData.next).not.toContain('Establish coverage');
  });
});

describe('buildCoverageAdvisoryIssue', () => {
  it('returns null when nothing is in the middle tier', () => {
    expect(buildCoverageAdvisoryIssue([])).toBeNull();
  });

  it('small count (<= 5): lists the files directly inline, singular/plural correct', () => {
    const one = buildCoverageAdvisoryIssue(['src/a.ts']);
    expect(one!.code).toBe('uncovered-advisory');
    expect(one!.severity).toBe('warning');
    expect(one!.messageData.what).toContain('1 coverage-visible file outside any required coverage root');
    expect(one!.messageData.what).toContain('src/a.ts');
    expect(one!.messageData.what).not.toContain('... and');

    const few = buildCoverageAdvisoryIssue(['src/a.ts', 'src/b.ts']);
    expect(few!.messageData.what).toContain('2 coverage-visible files outside any required coverage root');
  });

  it('large count (> 5): lists a 5-file sample plus a remaining-count tail', () => {
    const many = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const issue = buildCoverageAdvisoryIssue(many);
    expect(issue!.messageData.what).toContain('8 coverage-visible files outside any required coverage root');
    expect(issue!.messageData.what).toContain('src/f0.ts');
    expect(issue!.messageData.what).not.toContain('src/f5.ts'); // beyond the 5-file sample
    expect(issue!.messageData.what).toContain('... and 3 more');
    expect(issue!.uncoveredCount).toBe(8);
  });
});

describe('normalizeRoot', () => {
  it('maps "/" to empty string and strips slashes', () => {
    expect(normalizeRoot('/')).toBe('');
    expect(normalizeRoot('/services/')).toBe('services');
    expect(normalizeRoot('services')).toBe('services');
  });

  it('collapses internal double-slashes', () => {
    // Fix 3: internal slash runs must be collapsed so roots match single-slash git paths
    expect(normalizeRoot('/services//nested/')).toBe('services/nested');
  });
});

describe('matchesRoot', () => {
  it('empty root (whole repo) matches every file', () => {
    expect(matchesRoot('src/a.ts', '')).toBe(true);
  });
  it('matches exact and under-directory, not siblings', () => {
    expect(matchesRoot('services', 'services')).toBe(true);
    expect(matchesRoot('services/a.ts', 'services')).toBe(true);
    expect(matchesRoot('services2/a.ts', 'services')).toBe(false);
  });
});

describe('partitionByCoverageTier', () => {
  it('default whole-repo required → all files are required (error tier)', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], { required: ['/'], excluded: [], typeLevel: false });
    expect(r.required.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
    expect(r.middle).toEqual([]);
  });
  it('empty required ("require nothing") → every uncovered file is a non-blocking warning', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], { required: [], excluded: [], typeLevel: false });
    expect(r.required).toEqual([]); // nothing blocks
    expect(r.middle.sort()).toEqual(['lib/b.ts', 'src/a.ts']); // all surface as advisory
  });
  it('empty required with excluded → excluded silent, the rest warn', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'vendor/c.ts'], { required: [], excluded: ['vendor/'], typeLevel: false });
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual(['src/a.ts']); // vendor/c.ts dropped (silent)
  });
  it('files outside required fall to middle (warning), excluded are dropped', () => {
    const r = partitionByCoverageTier(
      ['services/a.ts', 'lib/b.ts', 'vendor/c.ts'],
      { required: ['services/'], excluded: ['vendor/'], typeLevel: false },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual(['lib/b.ts']);
  });
  it('longest match wins; excluded wins an equal-length tie', () => {
    const r = partitionByCoverageTier(
      ['services/legacy/x.ts', 'services/a.ts'],
      { required: ['services/'], excluded: ['services/legacy/'], typeLevel: false },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('Fix 8a: TRUE equal-length tie — file under both required and excluded same length → excluded wins (silent)', () => {
    // required: ['foo/'] and excluded: ['foo/'] — same normalized length ('foo')
    // so excluded wins the tie and foo/x.ts is silent
    const r = partitionByCoverageTier(
      ['foo/x.ts'],
      { required: ['foo/'], excluded: ['foo/'], typeLevel: false },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('Fix 8a: multi-required overlap — longer specific root wins for file under both roots', () => {
    // services/auth/x.ts matches both 'services/' (len 8) and 'services/auth/' (len 13)
    // → longer match ('services/auth/') wins → required tier
    const r = partitionByCoverageTier(
      ['services/auth/x.ts', 'services/billing/y.ts'],
      { required: ['services/', 'services/auth/'], excluded: [], typeLevel: false },
    );
    expect(r.required.sort()).toEqual(['services/auth/x.ts', 'services/billing/y.ts']);
    expect(r.middle).toEqual([]);
  });
});

describe('partitionByCoverageTier — absolute exclusion', () => {
  it('a required root nested inside a broader excluded root is silenced entirely — required no longer wins on specificity', () => {
    const r = partitionByCoverageTier(
      ['services/api/h.ts', 'services/other/x.ts'],
      { required: ['services/api/'], excluded: ['services/'], typeLevel: false },
    );
    // Before: services/api/h.ts landed in `required` (longer match wins).
    // After: ANY excluded match silences the file outright, regardless of
    // whether a more specific required root also matches it.
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('equal-length tie still resolves to excluded (unchanged outcome, now for a structural reason: excluded is checked FIRST, not because it "wins a tie")', () => {
    const r = partitionByCoverageTier(['foo/x.ts'], { required: ['foo/'], excluded: ['foo/'], typeLevel: false });
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('a required root NOT contained in any excluded root is unaffected', () => {
    const r = partitionByCoverageTier(
      ['services/x.ts'],
      { required: ['services/'], excluded: ['vendor/'], typeLevel: false },
    );
    expect(r.required).toEqual(['services/x.ts']);
  });
});

describe('isExcludedByCoverage', () => {
  it('true for a file under a plain excluded root', () => {
    expect(isExcludedByCoverage('vendor/lib.ts', { required: [], excluded: ['vendor/'], typeLevel: false })).toBe(true);
  });
  it('true for a file under a glob excluded root', () => {
    expect(isExcludedByCoverage('src/x.generated.ts', { required: [], excluded: ['**/*.generated.ts'], typeLevel: false })).toBe(true);
  });
  it('false when no excluded root matches', () => {
    expect(isExcludedByCoverage('src/a.ts', { required: [], excluded: ['vendor/'], typeLevel: false })).toBe(false);
  });
  it('true regardless of a required root also matching (the SCOPE GUARD fact, at the predicate level)', () => {
    expect(isExcludedByCoverage('services/api/h.ts', { required: ['services/api/'], excluded: ['services/'], typeLevel: false })).toBe(true);
  });
});

describe('checkRequiredShadowedByExcluded', () => {
  it('warns when a plain required root is fully inside a plain excluded root', () => {
    const issues = checkRequiredShadowedByExcluded({ required: ['src/misc/'], excluded: ['src/'], typeLevel: false });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].code).toBe('coverage-required-shadowed');
    expect(issues[0].messageData.what).toContain('src/misc/');
    expect(issues[0].messageData.what).toContain('src/');
    // Plain-language pin: WHY must never leak the internal "middle" tier name —
    // no other user-facing text uses it, so this message must not either.
    expect(issues[0].messageData.why).not.toContain('middle');
    expect(issues[0].messageData.why).toContain('blocking or advisory tier');
  });
  it('warns on an EXACT match (required === excluded, both normalize equal)', () => {
    const issues = checkRequiredShadowedByExcluded({ required: ['foo/'], excluded: ['foo/'], typeLevel: false });
    expect(issues).toHaveLength(1);
  });
  it('does NOT warn when the required root is not contained in any excluded root', () => {
    const issues = checkRequiredShadowedByExcluded({ required: ['services/'], excluded: ['vendor/'], typeLevel: false });
    expect(issues).toEqual([]);
  });
  it('does NOT warn on a glob required or excluded root — glob-vs-glob shadowing is undecidable, documented not warned', () => {
    expect(checkRequiredShadowedByExcluded({ required: ['src/**'], excluded: ['src/'], typeLevel: false })).toEqual([]);
    expect(checkRequiredShadowedByExcluded({ required: ['src/misc/'], excluded: ['**/misc/**'], typeLevel: false })).toEqual([]);
  });
  it('one warning per shadowed required root, not one per excluded root it happens to match', () => {
    const issues = checkRequiredShadowedByExcluded({
      required: ['src/misc/'],
      excluded: ['src/', 'src/misc/'], // both would shadow it
      typeLevel: false,
    });
    expect(issues).toHaveLength(1);
  });
});

describe('matchesRoot — glob roots', () => {
  it('a ** glob root matches files at any depth', () => {
    expect(matchesRoot('a/b/c.generated.ts', '**/*.generated.ts')).toBe(true);
    expect(matchesRoot('x.generated.ts', '**/*.generated.ts')).toBe(true);
  });
  it('a single-star glob root stays within one segment', () => {
    expect(matchesRoot('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesRoot('src/sub/foo.ts', 'src/*.ts')).toBe(false);
  });
  it('plain roots keep exact / directory-prefix semantics (backward compat)', () => {
    expect(matchesRoot('services', 'services')).toBe(true);
    expect(matchesRoot('services/a.ts', 'services')).toBe(true);
    expect(matchesRoot('services2/a.ts', 'services')).toBe(false);
  });
});

describe('partitionByCoverageTier — glob roots', () => {
  it('excluded glob drops generated files anywhere; the rest stay in their tier', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'src/x.generated.ts', 'lib/y.generated.ts'],
      { required: ['/'], excluded: ['**/*.generated.ts'], typeLevel: false },
    );
    expect(r.required).toEqual(['src/a.ts']); // generated files dropped (silent)
    expect(r.middle).toEqual([]);
  });

  it('required glob scopes the blocking tier; non-matching files fall to warning', () => {
    const r = partitionByCoverageTier(
      ['services/auth/api/h.ts', 'services/auth/internal/x.ts'],
      { required: ['services/*/api/**'], excluded: [], typeLevel: false },
    );
    expect(r.required).toEqual(['services/auth/api/h.ts']);
    expect(r.middle).toEqual(['services/auth/internal/x.ts']);
  });
});
