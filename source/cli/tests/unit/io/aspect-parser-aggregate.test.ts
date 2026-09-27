import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

// Aggregating aspect: a content-less, check-less aspect that only `implies`
// other aspects. The reviewer kind is INFERRED from file presence and the
// parser populates a normalized reviewer.type in {llm, deterministic, aggregate}.
describe('aspect-parser — aggregating aspect (inferred kind)', () => {
  let root: string;
  let aspectDir: string;
  let yamlPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-aspect-parser-aggregate-'));
    aspectDir = path.join(root, 'bundle');
    mkdirSync(aspectDir, { recursive: true });
    yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('infers reviewer.type: aggregate when neither file present and implies is set, with no reviewer block', async () => {
    writeFileSync(yamlPath, 'name: Bundle\ndescription: x\nimplies:\n  - rule-a\n  - rule-b\n');
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('aggregate');
      expect(r.aspect.reviewer.tier).toBeUndefined();
      expect(r.aspect.implies).toEqual(['rule-a', 'rule-b']);
    }
  });

  it('infers reviewer.type: llm when content.md present and no reviewer block', async () => {
    writeFileSync(yamlPath, 'name: Foo\ndescription: x\n');
    writeFileSync(path.join(aspectDir, 'content.md'), '# Foo\nrule.');
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('llm');
  });

  it('infers reviewer.type: deterministic when check.mjs present and no reviewer block', async () => {
    writeFileSync(yamlPath, 'name: Foo\ndescription: x\n');
    writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }');
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('deterministic');
  });

  it('errors when neither file present and no implies and no reviewer block (aspect that does nothing)', async () => {
    writeFileSync(yamlPath, 'name: Foo\ndescription: x\n');
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-rule-source-missing')).toBe(true);
  });

  it('errors when an empty implies list is the only thing and no reviewer block', async () => {
    writeFileSync(yamlPath, 'name: Foo\ndescription: x\nimplies: []\n');
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-rule-source-missing')).toBe(true);
  });

  it('accepts an explicit reviewer.type: aggregate that agrees with the inferred kind', async () => {
    // neither rule file + implies → inferred kind is aggregate; an explicit
    // reviewer.type: aggregate AGREES with the inference, so the parser accepts it.
    // Documented as valid across schema, knowledge, agent-rules, and CHANGELOG.
    writeFileSync(
      yamlPath,
      'name: Bundle\ndescription: x\nimplies:\n  - rule-a\nreviewer:\n  type: aggregate\n',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(true);
  });

  it('errors with aspect-references-on-aggregate when an inferred aggregate declares references', async () => {
    // An aggregate has no LLM reviewer, so references are meaningless.
    writeFileSync(
      yamlPath,
      'name: Bundle\ndescription: x\nimplies:\n  - rule-a\nreferences:\n  - some/lookup.md\n',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'bundle');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-references-on-aggregate')).toBe(true);
  });
});
