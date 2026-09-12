// =============================================================================
// Unit — adapting a rule you did not write.
//
// A rule installed from a package is copied in verbatim and never edited.
// Everything the installing repository wants different is written beside the
// copy and merged over the rule's own definition before any of it is validated.
// What is pinned here:
//
//   1. merge rules   — scalars replace, lists REPLACE (never combine), maps merge
//   2. refusals      — a key that is not adaptable, and a key nobody recognises
//   3. settings      — unknown key by name, wrong type by name and type
//   4. absence       — no file, an empty one, and a comment-only one all mean the same
//   5. companion:    — repo-relative, must exist at LOAD time
//
// Points 1 and 2 carry a documented decision each; both sides of each are
// asserted, so the choice cannot be reversed by accident.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { mergeAdaptOverAspect } from '../../../src/io/aspect-adapt-parser.js';
import type { PackageConfigKeyDef } from '../../../src/model/packages.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONFIG_SCHEMA: Record<string, PackageConfigKeyDef> = {
  threshold: { type: 'number', default: 3 },
  label: { type: 'string', default: 'house' },
  strict: { type: 'boolean', default: false },
};

/**
 * A project root holding one installed rule, so `parseAspect` is exercised over
 * the real directory shape rather than a synthesized one.
 */
function installedRule(aspectYaml: string, adaptYaml?: string, ruleFile: 'content.md' | 'check.mjs' = 'content.md'): {
  root: string;
  aspectDir: string;
  id: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'yg-adapt-'));
  tempDirs.push(root);
  const id = 'packages/acme/law/demo/rule-a';
  const aspectDir = join(root, '.yggdrasil', 'aspects', ...id.split('/'));
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(join(aspectDir, 'yg-aspect.yaml'), aspectYaml, 'utf-8');
  writeFileSync(join(aspectDir, ruleFile), ruleFile === 'content.md' ? '# Rule\n' : 'export function check() { return []; }\n', 'utf-8');
  if (adaptYaml !== undefined) writeFileSync(join(aspectDir, 'yg-aspect.adapt.yaml'), adaptYaml, 'utf-8');
  return { root, aspectDir, id };
}

async function parse(aspectYaml: string, adaptYaml?: string, ruleFile: 'content.md' | 'check.mjs' = 'content.md') {
  const { root, aspectDir, id } = installedRule(aspectYaml, adaptYaml, ruleFile);
  return {
    root,
    aspectDir,
    result: await parseAspect(aspectDir, join(aspectDir, 'yg-aspect.yaml'), id, {
      projectRoot: root,
      package: {
        packageName: 'demo',
        idPrefix: 'packages/acme/law/demo',
        aspectDirs: ['rule-a'],
        relativeId: 'rule-a',
        configSchema: CONFIG_SCHEMA,
      },
    }),
  };
}

const BASE = `name: Rule A
description: What the package says this rule means.
reviewer:
  type: llm
  tier: standard
status: enforced
review_by: 2027-01-01
references:
  - docs/from-package.md
scope:
  per: node
`;

// ---------------------------------------------------------------------------
// 1. How the merge combines values
// ---------------------------------------------------------------------------

describe('what an adaptation does to a rule it sits beside', () => {
  it('a scalar from the adaptation wins', async () => {
    const { result } = await parse(BASE, 'status: advisory\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.status).toBe('advisory');
    // Untouched keys keep what the package said.
    expect(result.aspect.reviewBy).toBe('2027-01-01');
  });

  it('a map merges key by key — the tier changes, the kind stays the package\'s', async () => {
    // The documented choice. Whole-map replacement was rejected because the one
    // field anyone wants to change here is `tier`, and replacement would force
    // them to restate `type` — which is not theirs to state: it is fixed by which
    // rule file the package ships.
    const { result } = await parse(BASE, 'reviewer:\n  tier: cheap\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.reviewer.tier).toBe('cheap');
    expect(result.aspect.reviewer.type).toBe('llm');
  });

  it('a list REPLACES rather than combining', async () => {
    // The other side of the same choice: a list that combined could never be
    // shortened, so a repository could add a reference but never drop one.
    const { result } = await parse(BASE, 'references:\n  - docs/ours.md\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.references).toEqual([{ path: 'docs/ours.md', description: undefined }]);
  });

  it('the merge is one level deep, so a nested structure can be replaced outright', () => {
    const merged = mergeAdaptOverAspect(
      { scope: { per: 'node', files: { path: 'src/**' } } },
      { scope: { files: { path: 'lib/**' } } },
    );
    expect(merged.scope).toEqual({ per: 'node', files: { path: 'lib/**' } });
  });
});

// ---------------------------------------------------------------------------
// 2. What an adaptation may not touch
// ---------------------------------------------------------------------------

describe('what an adaptation is refused', () => {
  it.each(['name', 'implies', 'errs', 'when', 'description'])(
    'refuses %s, naming the key and saying it is not adaptable',
    async (key) => {
      const value = key === 'implies' ? '[other]' : key === 'when' ? '{ node: { type: x } }' : key === 'errs' ? 'over' : 'Something Else';
      const { result } = await parse(BASE, `${key}: ${value}\n`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].code).toBe('aspect-adapt-key-not-adaptable');
      expect(result.errors[0].messageData.what).toContain(`'${key}'`);
      expect(result.errors[0].messageData.what).toContain('not adaptable');
    },
  );

  it('refuses a key it does not recognise at all', async () => {
    // A DELIBERATE asymmetry with yg-aspect.yaml, which tolerates an unknown
    // top-level key. The two are written under different conditions: a rule's own
    // file is authored once against the schema its author had, and tolerating a
    // newer build's key is what lets one rule work across versions. An adaptation
    // is written by someone tuning a rule they did not write, where a misspelled
    // key reads as a change that was applied when it was silently dropped.
    const { result } = await parse(BASE, 'reviwer:\n  tier: cheap\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-adapt-key-unknown');
    expect(result.errors[0].messageData.what).toContain('reviwer');
  });

  it('the rule\'s OWN file still tolerates an unknown key — the other half of that asymmetry', async () => {
    const { result } = await parse(`${BASE}somethingNewer: 1\n`);
    expect(result.ok).toBe(true);
  });

  it.each(['- a\n- b\n', '42\n'])('refuses an adaptation that is not a mapping (%j)', async (body) => {
    const { result } = await parse(BASE, body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-adapt-not-mapping');
  });
});

// ---------------------------------------------------------------------------
// 3. Settings
// ---------------------------------------------------------------------------

describe('the settings an adaptation sets', () => {
  it('takes the package defaults when the adaptation sets none', async () => {
    const { result } = await parse(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.config).toEqual({ threshold: 3, label: 'house', strict: false });
  });

  it('overrides only the keys it names', async () => {
    const { result } = await parse(BASE, 'config:\n  threshold: 40\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.config).toEqual({ threshold: 40, label: 'house', strict: false });
  });

  it('refuses a key the package does not declare, naming it and the package', async () => {
    const { result } = await parse(BASE, 'config:\n  treshold: 40\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-adapt-config-key-unknown');
    expect(result.errors[0].messageData.what).toContain('treshold');
    expect(result.errors[0].messageData.what).toContain('demo');
  });

  it('refuses a value of the wrong type, naming the key and the type', async () => {
    const { result } = await parse(BASE, 'config:\n  threshold: "forty"\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-adapt-config-type-mismatch');
    expect(result.errors[0].messageData.what).toContain('threshold');
    expect(result.errors[0].messageData.what).toContain('number');
  });

  it('refuses a config block that is not a mapping', async () => {
    const { result } = await parse(BASE, 'config: 40\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-adapt-config-not-mapping');
  });
});

// ---------------------------------------------------------------------------
// 4. Absence, in its three forms
// ---------------------------------------------------------------------------

describe('an adaptation that asks for nothing', () => {
  it.each([
    ['no file at all', undefined],
    ['an empty mapping', '{}\n'],
    ['comments only', '# nothing yet\n# threshold: 40\n'],
  ])('%s leaves the rule exactly as the package published it', async (_label, body) => {
    // The third form is the file `yg pack add` writes: a stub full of commented
    // keys must not change anything until someone uncomments a line.
    const { result } = await parse(BASE, body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.status).toBe('enforced');
    expect(result.aspect.reviewer.tier).toBe('standard');
    expect(result.aspect.references).toEqual([{ path: 'docs/from-package.md', description: undefined }]);
  });

  it('the adaptation file never becomes one of the rule\'s own files', async () => {
    // It would otherwise ride into the rule hash and make every adapted rule look
    // like a different rule.
    const { result } = await parse(BASE, 'status: advisory\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.artifacts.map((a) => a.filename)).not.toContain('yg-aspect.adapt.yaml');
  });
});

// ---------------------------------------------------------------------------
// 5. companion:
// ---------------------------------------------------------------------------

describe('a rule pointed at a companion of your own', () => {
  it('accepts a repo-relative module that exists, and folds its bytes in as the rule\'s own', async () => {
    const { root, aspectDir, id } = installedRule(BASE);
    mkdirSync(join(root, 'tools'));
    writeFileSync(join(root, 'tools', 'mine.mjs'), 'export function companion() { return []; }\n', 'utf-8');
    writeFileSync(join(aspectDir, 'yg-aspect.adapt.yaml'), 'companion: tools/mine.mjs\n', 'utf-8');

    const result = await parseAspect(aspectDir, join(aspectDir, 'yg-aspect.yaml'), id, { projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.companionPath).toBe('tools/mine.mjs');
    expect(result.aspect.hasCompanion).toBe(true);
    // Carried under the name the rest of the system looks for, so an edit to YOUR
    // module invalidates the verdicts it helped produce.
    const artifact = result.aspect.artifacts.find((a) => a.filename === 'companion.mjs');
    expect(artifact?.content).toContain('export function companion');
  });

  it('refuses a companion pointing outside the repository', async () => {
    const { result } = await parse(BASE, 'companion: ../../elsewhere/mine.mjs\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-companion-escape');
  });

  it('refuses a companion that is not there — at LOAD time, not at first run', async () => {
    // A companion discovered missing on the rule's first run would surface as an
    // infrastructure failure in the middle of a review instead of a graph error.
    const { result } = await parse(BASE, 'companion: tools/absent.mjs\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-companion-missing');
    expect(result.errors[0].messageData.what).toContain('tools/absent.mjs');
  });
});
