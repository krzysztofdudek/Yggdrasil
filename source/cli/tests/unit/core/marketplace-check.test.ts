// =============================================================================
// Unit — the five questions a marketplace is asked before it publishes.
//
// The check runs in the PUBLISHING repository, which has no `.yggdrasil/` of its
// own, so everything here is decided from manifests, rule directories and the
// text of the rules. Each block below is one of the five, and each failure mode
// asserts the CODE rather than the sentence — the sentence is allowed to improve.
//
//   (a) manifests    1-6    the two documents against the directories that exist
//   (b) rules         7-10   every rule loads, under the consumer's own loader
//   (c) implies      11-12   a package stands on its own
//   (d) settings     13-19   read but undeclared is an error; the rest is honest
//   (e) portability  20-35   the rule still means this elsewhere, and ships proof
//   codes            36-37   disjoint, and nothing emitted from outside the set
// =============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  checkMarketplace,
  MARKETPLACE_ERROR_CODES,
  MARKETPLACE_WARNING_CODES,
} from '../../../src/core/marketplace-check.js';
import type { MarketplaceCheckResult } from '../../../src/core/marketplace-check.js';

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal marketplace that passes every check: one package, one deterministic
 * rule reading nothing, and the pair of cases that rule needs. Every test below
 * patches exactly one thing in it, so a failing assertion names one cause.
 */
const BASE: Record<string, string> = {
  'yg-marketplace.yaml': [
    'schema: yg-marketplace/1',
    'packages:',
    '  - name: demo',
    '    path: packages/demo',
    '    version: 1.0.0',
    '',
  ].join('\n'),
  'packages/demo/yg-package.yaml': [
    'schema: yg-package/1',
    'name: demo',
    'version: 1.0.0',
    'requires:',
    '  yg: ">=6.0.0"',
    'aspects:',
    '  - rule',
    '',
  ].join('\n'),
  'packages/demo/rule/yg-aspect.yaml': [
    'name: TheRule',
    'description: A rule that refuses nothing, so the test is about everything else.',
    'reviewer:',
    '  type: deterministic',
    '',
  ].join('\n'),
  'packages/demo/rule/check.mjs': 'export function check(ctx) {\n  return [];\n}\n',
  'packages/demo/rule/drills/violates-bad/src/a.ts': 'export const a = 1;\n',
  'packages/demo/rule/drills/satisfies-good/src/a.ts': 'export const a = 1;\n',
};

/** Write a tree to a fresh temporary directory and return its path. */
function write(label: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mkt-${label}-`));
  created.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, ...relPath.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

/** The base marketplace with `patch` applied — a null value removes a file. */
function marketplace(label: string, patch: Record<string, string | null> = {}): string {
  const files: Record<string, string> = { ...BASE };
  for (const [relPath, content] of Object.entries(patch)) {
    if (content === null) delete files[relPath];
    else files[relPath] = content;
  }
  return write(label, files);
}

const codesOf = (r: MarketplaceCheckResult): string[] => [
  ...r.errors.map((e) => e.code),
  ...r.warnings.map((w) => w.code),
];

/** Run the check on a patched base and return the result. */
async function run(label: string, patch: Record<string, string | null> = {}): Promise<MarketplaceCheckResult> {
  return checkMarketplace(marketplace(label, patch));
}

// ---------------------------------------------------------------------------
// (a) The manifests, and the directories they claim
// ---------------------------------------------------------------------------

describe('(a) the manifests against what is on disk', () => {
  it('1: a marketplace with nothing wrong reports nothing at all', async () => {
    const result = await run('clean');
    expect(codesOf(result)).toEqual([]);
  });

  it('2: no marketplace manifest is refused by name, and never mentions a missing graph', async () => {
    const dir = write('nomanifest', { 'README.md': '# not a marketplace\n' });
    const result = await checkMarketplace(dir);
    expect(result.errors.map((e) => e.code)).toEqual(['marketplace-manifest-missing']);
    const said = JSON.stringify(result.errors[0].messageData);
    expect(said).toContain('yg-marketplace.yaml');
    // The command does not load a graph, so it can never ask for one.
    expect(said).not.toContain('.yggdrasil');
  });

  it('3: a manifest with no schema line is refused', async () => {
    const result = await run('noschema', {
      'yg-marketplace.yaml': 'packages: []\n',
    });
    expect(result.errors.map((e) => e.code)).toEqual(['marketplace-manifest-invalid']);
  });

  it('4: an entry naming a directory that is not there is refused, naming the path', async () => {
    const result = await run('entrymissing', {
      'yg-marketplace.yaml': [
        'schema: yg-marketplace/1',
        'packages:',
        '  - name: demo',
        '    path: packages/demo',
        '    version: 1.0.0',
        '  - name: ghost',
        '    path: packages/ghost',
        '    version: 1.0.0',
        '',
      ].join('\n'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['marketplace-entry-missing']);
    expect(result.errors[0].messageData.what).toContain('packages/ghost');
  });

  it('5: a directory under packages/ that no entry lists is refused', async () => {
    const result = await run('dirunlisted', {
      'packages/stray/yg-package.yaml': 'schema: yg-package/1\n',
    });
    expect(result.errors.map((e) => e.code)).toEqual(['marketplace-dir-unlisted']);
    expect(result.errors[0].subject).toBe('packages/stray');
  });

  it('6: a version that is not semver is refused', async () => {
    const result = await run('badversion', {
      'yg-marketplace.yaml': [
        'schema: yg-marketplace/1',
        'packages:',
        '  - name: demo',
        '    path: packages/demo',
        '    version: latest',
        '',
      ].join('\n'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['marketplace-manifest-invalid']);
  });

  it("7: a package whose manifest calls it something else is refused, naming all three", async () => {
    const result = await run('namemismatch', {
      'packages/demo/yg-package.yaml': BASE['packages/demo/yg-package.yaml'].replace(
        'name: demo',
        'name: something-else',
      ),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-name-mismatch']);
    const what = result.errors[0].messageData.what;
    expect(what).toContain('something-else');
    expect(what).toContain('demo');
  });

  it('8: a config key with no type is refused as a manifest fault', async () => {
    const result = await run('notype', {
      'packages/demo/yg-package.yaml':
        BASE['packages/demo/yg-package.yaml'] +
        ['config:', '  rule:', '    threshold:', '      default: 3', ''].join('\n'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-manifest-invalid']);
  });

  it('9: a config default that contradicts its own type is refused', async () => {
    const result = await run('badtype', {
      'packages/demo/yg-package.yaml':
        BASE['packages/demo/yg-package.yaml'] +
        ['config:', '  rule:', '    threshold:', '      type: number', '      default: "three"', ''].join('\n'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-manifest-invalid']);
  });
});

// ---------------------------------------------------------------------------
// (b) Every rule loads, under the loader a consumer will use
// ---------------------------------------------------------------------------

describe('(b) every rule loads in package mode', () => {
  it('10: a rule shipping both a script and prose is refused', async () => {
    const result = await run('bothsources', {
      'packages/demo/rule/content.md': '# Prose\n\nAlso a script. Pick one.\n',
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-aspect-invalid']);
    expect(result.errors[0].messageData.what).toContain('check.mjs');
  });

  it('11: a rule shipping neither, and implying nothing, is refused', async () => {
    const result = await run('nosource', {
      'packages/demo/rule/check.mjs': null,
      'packages/demo/rule/drills/violates-bad/src/a.ts': null,
      'packages/demo/rule/drills/satisfies-good/src/a.ts': null,
      'packages/demo/rule/yg-aspect.yaml': [
        'name: TheRule',
        'description: A rule with no script, no prose and nothing to bundle.',
        '',
      ].join('\n'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-aspect-invalid']);
  });

  it('12: a rule with no yg-aspect.yaml at all is refused, naming the rule', async () => {
    const result = await run('noaspectyaml', {
      'packages/demo/rule/yg-aspect.yaml': null,
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-aspect-invalid']);
    expect(result.errors[0].messageData.what).toContain('yg-aspect.yaml');
  });

  it('13: a rule directory the manifest never declared is refused', async () => {
    const result = await run('undeclareddir', {
      'packages/demo/extra/yg-aspect.yaml': 'name: Extra\nreviewer:\n  type: llm\n',
      'packages/demo/extra/content.md': '# Extra\n',
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-manifest-invalid']);
  });
});

// ---------------------------------------------------------------------------
// (c) A package stands on its own
// ---------------------------------------------------------------------------

describe('(c) implies stays inside the package', () => {
  const bundle = (target: string): Record<string, string | null> => ({
    'packages/demo/yg-package.yaml': BASE['packages/demo/yg-package.yaml'].replace(
      '  - rule\n',
      '  - rule\n  - bundle\n',
    ),
    'packages/demo/bundle/yg-aspect.yaml': [
      'name: TheBundle',
      'description: A rule that bundles others.',
      'implies:',
      `  - ${target}`,
      '',
    ].join('\n'),
  });

  it('14: implying a rule of this package is fine', async () => {
    const result = await run('impliesok', bundle('rule'));
    expect(codesOf(result)).toEqual([]);
  });

  it('15: implying a full path leaves the package and is refused, naming both', async () => {
    const result = await run('impliespath', bundle('packages/acme/law/other/naming'));
    expect(result.errors.map((e) => e.code)).toEqual(['package-implies-escapes']);
    const what = result.errors[0].messageData.what;
    expect(what).toContain('bundle');
    expect(what).toContain('packages/acme/law/other/naming');
  });

  it('16: implying a name this package does not carry is refused, naming both', async () => {
    const result = await run('impliesother', bundle('somebody-elses-rule'));
    expect(result.errors.map((e) => e.code)).toEqual(['package-implies-escapes']);
    const what = result.errors[0].messageData.what;
    expect(what).toContain('bundle');
    expect(what).toContain('somebody-elses-rule');
  });
});

// ---------------------------------------------------------------------------
// (d) Settings: read but undeclared is an error, and the rest is honest
// ---------------------------------------------------------------------------

/** The base package manifest with a `config:` block for the one rule. */
function withConfig(block: string): string {
  return BASE['packages/demo/yg-package.yaml'] + block;
}

const THRESHOLD_DECLARED = ['config:', '  rule:', '    threshold:', '      type: number', '      default: 3', ''].join('\n');

describe('(d) settings declared against settings read', () => {
  it('17: a setting read and declared is silent', async () => {
    const result = await run('configok', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
      'packages/demo/rule/check.mjs':
        'export function check(ctx) {\n  return ctx.config.threshold > 0 ? [] : [];\n}\n',
    });
    expect(codesOf(result)).toEqual([]);
  });

  it('18: a setting read and never declared is an ERROR, naming the key', async () => {
    const result = await run('configundeclared', {
      'packages/demo/rule/check.mjs':
        'export function check(ctx) {\n  return ctx.config.threshold > 0 ? [] : [];\n}\n',
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-config-undeclared']);
    expect(result.errors[0].messageData.what).toContain('threshold');
  });

  it('19: a setting declared and never read is a WARNING, not an error', async () => {
    const result = await run('configunused', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['package-config-unused']);
    expect(result.warnings[0].messageData.what).toContain('threshold');
  });

  it('20: a setting reached through a computed name is a WARNING, never an error', async () => {
    const result = await run('configdynamic', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
      'packages/demo/rule/check.mjs':
        'export function check(ctx) {\n  const which = "thres" + "hold";\n  return ctx.config[which] > 0 ? [] : [];\n}\n',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['package-config-dynamic']);
  });

  it('21: a computed name also silences the declared-but-unread direction', async () => {
    // The reading is admittedly incomplete, so concluding that a declared key is
    // never read would be asserting something this check cannot see.
    const result = await run('configdynamicquiet', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
      'packages/demo/rule/check.mjs':
        'export function check(ctx) {\n  return ctx.config[ctx.subject.length] ? [] : [];\n}\n',
    });
    expect(result.warnings.map((w) => w.code)).toEqual(['package-config-dynamic']);
  });

  it('22: a literal subscript names a key like a dotted access does', async () => {
    const result = await run('configsubscript', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
      'packages/demo/rule/check.mjs':
        'export function check(ctx) {\n  return ctx.config["threshold"] > 0 ? [] : [];\n}\n',
    });
    expect(codesOf(result)).toEqual([]);
  });

  it('23: destructuring the settings object names every key it takes', async () => {
    const result = await run('configdestructure', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
      'packages/demo/rule/check.mjs':
        'export function check(ctx) {\n  const { threshold } = ctx.config;\n  return threshold > 0 ? [] : [];\n}\n',
    });
    expect(codesOf(result)).toEqual([]);
  });

  it('24: a key named only inside a comment or a string is not a read', async () => {
    const result = await run('configcomment', {
      'packages/demo/yg-package.yaml': withConfig(THRESHOLD_DECLARED),
      'packages/demo/rule/check.mjs': [
        'export function check(ctx) {',
        '  // Historically this read ctx.config.limit, which no longer exists.',
        '  const doc = "set ctx.config.limit in your adaptation";',
        '  return ctx.config.threshold > 0 ? [doc] : [];',
        '}',
        '',
      ].join('\n'),
    });
    // 'limit' is undeclared; had the comment or the string counted as a read,
    // this would be an error. Reading the syntax tree rather than the text is
    // what keeps it silent.
    expect(codesOf(result)).toEqual([]);
  });

  it('25: the context parameter is read off the rule, not assumed to be named ctx', async () => {
    const result = await run('configrenamed', {
      'packages/demo/rule/check.mjs':
        'export function check(context) {\n  return context.config.threshold > 0 ? [] : [];\n}\n',
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-config-undeclared']);
  });
});

// ---------------------------------------------------------------------------
// (e) Portability, and the proof a rule ships with itself
// ---------------------------------------------------------------------------

/** The base rule definition with extra lines appended. */
function withAspectLines(...lines: string[]): string {
  return BASE['packages/demo/rule/yg-aspect.yaml'] + lines.join('\n') + '\n';
}

describe('(e) portability and proof', () => {
  it('26: a glob anchored to a literal directory is refused, quoting the glob', async () => {
    const result = await run('literalroot', {
      'packages/demo/rule/yg-aspect.yaml': withAspectLines(
        'scope:',
        '  per: file',
        '  files:',
        '    path: "src/**/*.ts"',
      ),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-scope-literal-root']);
    expect(result.errors[0].messageData.what).toContain('src/**/*.ts');
  });

  it('27: the same glob made relative to any depth is fine', async () => {
    const result = await run('relativeroot', {
      'packages/demo/rule/yg-aspect.yaml': withAspectLines(
        'scope:',
        '  per: file',
        '  files:',
        '    path: "**/src/**/*.ts"',
      ),
    });
    expect(codesOf(result)).toEqual([]);
  });

  it('28: a literal root hiding inside a boolean branch is found too', async () => {
    const result = await run('literalrootnested', {
      'packages/demo/rule/yg-aspect.yaml': withAspectLines(
        'scope:',
        '  per: file',
        '  files:',
        '    all_of:',
        '      - path: "**/*.ts"',
        '      - not:',
        '          path: "test/**"',
      ),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-scope-literal-root']);
    expect(result.errors[0].messageData.what).toContain('test/**');
  });

  it('29: a review-by date in a published rule is refused', async () => {
    const result = await run('reviewby', {
      'packages/demo/rule/yg-aspect.yaml': withAspectLines('review_by: 2027-01-31'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-review-by-present']);
    expect(result.errors[0].messageData.what).toContain('2027-01-31');
  });

  it('30: a reference naming a path in the author\'s repository is refused', async () => {
    const result = await run('references', {
      'packages/demo/rule/check.mjs': null,
      'packages/demo/rule/drills/violates-bad/src/a.ts': null,
      'packages/demo/rule/drills/satisfies-good/src/a.ts': null,
      'packages/demo/rule/content.md': '# Prose\n\nJudge the naming.\n',
      'packages/demo/rule/yg-aspect.yaml': [
        'name: TheRule',
        'description: An LLM rule that leans on a table only its author has.',
        'reviewer:',
        '  type: llm',
        'references:',
        '  - docs/error-codes.md',
        '',
      ].join('\n'),
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-references-repo-path']);
    expect(result.errors[0].messageData.what).toContain('docs/error-codes.md');
  });

  it('31: asking for a named reviewer tier is a warning, not a refusal', async () => {
    const result = await run('tier', {
      'packages/demo/rule/check.mjs': null,
      'packages/demo/rule/drills/violates-bad/src/a.ts': null,
      'packages/demo/rule/drills/satisfies-good/src/a.ts': null,
      'packages/demo/rule/content.md': '# Prose\n\nJudge the naming.\n',
      'packages/demo/rule/yg-aspect.yaml': [
        'name: TheRule',
        'description: An LLM rule asking for a tier by name.',
        'reviewer:',
        '  type: llm',
        '  tier: deep',
        '',
      ].join('\n'),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['package-reviewer-tier']);
  });

  it('32: a deterministic rule with no cases at all is refused, naming the rule', async () => {
    const result = await run('nodrills', {
      'packages/demo/rule/drills/violates-bad/src/a.ts': null,
      'packages/demo/rule/drills/satisfies-good/src/a.ts': null,
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-drills-missing']);
    expect(result.errors[0].messageData.what).toContain('rule');
  });

  it('33: a rule proving only what it refuses, and never what it allows, is refused', async () => {
    const result = await run('halfdrills', {
      'packages/demo/rule/drills/satisfies-good/src/a.ts': null,
    });
    expect(result.errors.map((e) => e.code)).toEqual(['package-drills-missing']);
  });

  it('34: a case directory under neither prefix is a WARNING — the runner skips it silently', async () => {
    // Pinned choice. `discoverDrillCases` reads the FIRST path segment and ignores
    // anything that is not violates-/satisfies-, so such a directory contributes
    // no case at all while looking exactly like one. That is worth saying out
    // loud — and it is not an error, because shared material a case imports is a
    // legitimate reason to keep a directory in there.
    const result = await run('oddcase', {
      'packages/demo/rule/drills/fixtures/src/a.ts': 'export const a = 1;\n',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['package-drills-unrecognized']);
    expect(result.warnings[0].subject).toBe('packages/demo/rule/drills/fixtures');
  });

  it('35: an LLM rule needs no cases', async () => {
    const result = await run('llmnodrills', {
      'packages/demo/rule/check.mjs': null,
      'packages/demo/rule/drills/violates-bad/src/a.ts': null,
      'packages/demo/rule/drills/satisfies-good/src/a.ts': null,
      'packages/demo/rule/content.md': '# Prose\n\nJudge the naming.\n',
      'packages/demo/rule/yg-aspect.yaml': [
        'name: TheRule',
        'description: An LLM rule, judged by a reviewer reading prose.',
        'reviewer:',
        '  type: llm',
        '',
      ].join('\n'),
    });
    expect(codesOf(result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The code family itself
// ---------------------------------------------------------------------------

describe('the code family', () => {
  it('36: error codes and warning codes are disjoint, and each appears once', async () => {
    const errors = [...MARKETPLACE_ERROR_CODES];
    const warnings = [...MARKETPLACE_WARNING_CODES];
    expect(new Set(errors).size).toBe(errors.length);
    expect(new Set(warnings).size).toBe(warnings.length);
    expect(errors.filter((c) => (warnings as string[]).includes(c))).toEqual([]);
  });

  it('37: every code the check emits is one the family declares', async () => {
    const seen = new Set<string>();
    const collect = (r: MarketplaceCheckResult): void => {
      for (const e of r.errors) {
        expect(MARKETPLACE_ERROR_CODES as readonly string[]).toContain(e.code);
        seen.add(e.code);
      }
      for (const w of r.warnings) {
        expect(MARKETPLACE_WARNING_CODES as readonly string[]).toContain(w.code);
        seen.add(w.code);
      }
    };
    collect(await checkMarketplace(write('codes-empty', { 'README.md': '#\n' })));
    collect(await run('codes-dir', { 'packages/stray/yg-package.yaml': 'schema: yg-package/1\n' }));
    collect(await run('codes-reviewby', {
      'packages/demo/rule/yg-aspect.yaml': withAspectLines('review_by: 2027-01-31'),
    }));
    expect(seen.size).toBeGreaterThan(0);
  });
});
