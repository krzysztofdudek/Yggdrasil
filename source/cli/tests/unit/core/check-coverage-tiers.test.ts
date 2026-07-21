import { describe, it, expect } from 'vitest';
import {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
} from '../../../src/core/check.js';

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
    expect(one!.messageData.what).toContain('1 tracked file outside any required coverage root');
    expect(one!.messageData.what).toContain('src/a.ts');
    expect(one!.messageData.what).not.toContain('... and');

    const few = buildCoverageAdvisoryIssue(['src/a.ts', 'src/b.ts']);
    expect(few!.messageData.what).toContain('2 tracked files outside any required coverage root');
  });

  it('large count (> 5): lists a 5-file sample plus a remaining-count tail', () => {
    const many = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const issue = buildCoverageAdvisoryIssue(many);
    expect(issue!.messageData.what).toContain('8 tracked files outside any required coverage root');
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
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], { required: ['/'], excluded: [] });
    expect(r.required.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
    expect(r.middle).toEqual([]);
  });
  it('empty required ("require nothing") → every uncovered file is a non-blocking warning', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], { required: [], excluded: [] });
    expect(r.required).toEqual([]); // nothing blocks
    expect(r.middle.sort()).toEqual(['lib/b.ts', 'src/a.ts']); // all surface as advisory
  });
  it('empty required with excluded → excluded silent, the rest warn', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'vendor/c.ts'], { required: [], excluded: ['vendor/'] });
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual(['src/a.ts']); // vendor/c.ts dropped (silent)
  });
  it('files outside required fall to middle (warning), excluded are dropped', () => {
    const r = partitionByCoverageTier(
      ['services/a.ts', 'lib/b.ts', 'vendor/c.ts'],
      { required: ['services/'], excluded: ['vendor/'] },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual(['lib/b.ts']);
  });
  it('longest match wins; excluded wins an equal-length tie', () => {
    const r = partitionByCoverageTier(
      ['services/legacy/x.ts', 'services/a.ts'],
      { required: ['services/'], excluded: ['services/legacy/'] },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('Fix 8a: TRUE equal-length tie — file under both required and excluded same length → excluded wins (silent)', () => {
    // required: ['foo/'] and excluded: ['foo/'] — same normalized length ('foo')
    // so excluded wins the tie and foo/x.ts is silent
    const r = partitionByCoverageTier(
      ['foo/x.ts'],
      { required: ['foo/'], excluded: ['foo/'] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('Fix 8a: multi-required overlap — longer specific root wins for file under both roots', () => {
    // services/auth/x.ts matches both 'services/' (len 8) and 'services/auth/' (len 13)
    // → longer match ('services/auth/') wins → required tier
    const r = partitionByCoverageTier(
      ['services/auth/x.ts', 'services/billing/y.ts'],
      { required: ['services/', 'services/auth/'], excluded: [] },
    );
    expect(r.required.sort()).toEqual(['services/auth/x.ts', 'services/billing/y.ts']);
    expect(r.middle).toEqual([]);
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
      { required: ['/'], excluded: ['**/*.generated.ts'] },
    );
    expect(r.required).toEqual(['src/a.ts']); // generated files dropped (silent)
    expect(r.middle).toEqual([]);
  });

  it('required glob scopes the blocking tier; non-matching files fall to warning', () => {
    const r = partitionByCoverageTier(
      ['services/auth/api/h.ts', 'services/auth/internal/x.ts'],
      { required: ['services/*/api/**'], excluded: [] },
    );
    expect(r.required).toEqual(['services/auth/api/h.ts']);
    expect(r.middle).toEqual(['services/auth/internal/x.ts']);
  });
});
