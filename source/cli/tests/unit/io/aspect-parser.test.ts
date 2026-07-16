import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAspect, type ParseAspectResult } from '../../../src/io/aspect-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-aspect'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

const FIXTURE_DIR = path.join(
  __dirname,
  '../../fixtures/sample-project/.yggdrasil/aspects/requires-audit',
);

// Helper: assert result is ok and return aspect
function assertOk(r: ParseAspectResult) {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('Expected ok result');
  return r.aspect;
}

// Helper: assert result is not ok and return errors
function assertFail(r: ParseAspectResult) {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('Expected error result');
  return r.errors;
}

async function setupAspectDir(yaml: string, contentMd?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-test-'));
  await writeFile(path.join(dir, 'yg-aspect.yaml'), yaml);
  if (contentMd) await writeFile(path.join(dir, 'content.md'), contentMd);
  return dir;
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function newDir(yaml: string, md?: string) {
  const p = setupAspectDir(yaml, md);
  p.then(d => tempDirs.push(d));
  return p;
}

describe('aspect-parser', () => {
  it('parses valid yg-aspect.yaml correctly', async () => {
    const r = await parseAspect(
      path.join(FIXTURE_DIR),
      path.join(FIXTURE_DIR, 'yg-aspect.yaml'),
      'requires-audit',
    );
    const aspect = assertOk(r);
    expect(aspect.name).toBe('Audit Logging');
    expect(aspect.id).toBe('requires-audit');
    expect(aspect.artifacts).toBeDefined();
  });

  it('returns error on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(badPath, '', 'utf-8');

    const r = await parseAspect(tmpDir, badPath, 'empty-aspect');
    const errors = assertFail(r);
    expect(errors.some(e => e.code === 'yaml-invalid')).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(badPath, `implies: []\n`, 'utf-8');

    const r = await parseAspect(tmpDir, badPath, 'some-aspect');
    const errors = assertFail(r);
    expect(errors.some(e => e.code === 'aspect-name-missing')).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses id from directory path (3rd parameter)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-tag');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: My Aspect\nreviewer:\n  type: llm\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'my-directory-name');
    const aspect = assertOk(r);
    expect(aspect.id).toBe('my-directory-name');
    expect(aspect.name).toBe('My Aspect');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses implies when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: HIPAA\nreviewer:\n  type: llm\nimplies:\n  - requires-audit\n  - requires-encryption\n`,
      'utf-8',
    );
    const r = await parseAspect(tmpDir, aspectPath, 'requires-hipaa');
    const aspect = assertOk(r);
    expect(aspect.id).toBe('requires-hipaa');
    expect(aspect.implies).toEqual(['requires-audit', 'requires-encryption']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when id is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty-id');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\n`, 'utf-8');

    const r1 = await parseAspect(tmpDir, aspectPath, '');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.some(e => e.code === 'aspect-invalid-id')).toBe(true);

    const r2 = await parseAspect(tmpDir, aspectPath, '   ');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.some(e => e.code === 'aspect-invalid-id')).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when implies is not an array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-bad-implies');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nreviewer:\n  type: llm\nimplies: "not-an-array"\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'bad-implies');
    const errors = assertFail(r);
    expect(errors.some(e => e.code === 'aspect-implies-not-array')).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults optional fields when missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Minimal Aspect\nreviewer:\n  type: llm\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'minimal-aspect');
    const aspect = assertOk(r);
    expect(aspect.name).toBe('Minimal Aspect');
    expect(aspect.id).toBe('minimal-aspect');
    expect(aspect.artifacts).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('silently ignores unknown stability field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-stability');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Stable Aspect\nreviewer:\n  type: llm\nstability: protocol\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'stable');
    const aspect = assertOk(r);
    // unknown field should not cause an error
    expect(aspect.name).toBe('Stable Aspect');
    expect((aspect as unknown as Record<string, unknown>).stability).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses object-form reviewer { type: deterministic }', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-reviewer-obj-det');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nreviewer:\n  type: deterministic\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'test');
    const aspect = assertOk(r);
    expect(aspect.reviewer.type).toBe('deterministic');
    expect(aspect.reviewer.tier).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses object-form reviewer { type: llm, tier: expensive }', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-reviewer-obj-tier');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nreviewer:\n  type: llm\n  tier: expensive\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'test');
    const aspect = assertOk(r);
    expect(aspect.reviewer.type).toBe('llm');
    expect(aspect.reviewer.tier).toBe('expensive');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when reviewer is an array (invalid shape)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-reviewer-arr');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nreviewer: [llm, ast]\n`, 'utf-8');

    const r = await parseAspect(tmpDir, aspectPath, 'test');
    const errors = assertFail(r);
    expect(errors.some(e => e.code === 'aspect-reviewer-not-mapping')).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('silently ignores unknown anchors field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-anchors');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: Logging\nreviewer:\n  type: llm\nanchors:\n  - id: audit-entry\n    claim: "All mutations record an audit entry"\n`,
      'utf-8',
    );

    const r = await parseAspect(tmpDir, aspectPath, 'logging');
    const aspect = assertOk(r);
    expect(aspect.name).toBe('Logging');
    expect((aspect as unknown as Record<string, unknown>).anchors).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses all optional fields together', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-full');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: Full Aspect\nreviewer:\n  type: llm\ndescription: A fully specified aspect\nimplies:\n  - other-aspect\n`,
      'utf-8',
    );

    const r = await parseAspect(tmpDir, aspectPath, 'full-aspect');
    const aspect = assertOk(r);
    expect(aspect.name).toBe('Full Aspect');
    expect(aspect.description).toBe('A fully specified aspect');
    expect(aspect.implies).toEqual(['other-aspect']);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('aspect-parser — when filter', () => {
  it('parses top-level when', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-when');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'reviewer:',
      '  type: llm',
      'when:',
      '  relations:',
      '    calls:',
      '      target_type: service-client',
    ].join('\n'), 'utf-8');

    const r = await parseAspect(tmpDir, aspectYaml, 'example');
    const aspect = assertOk(r);
    expect(aspect.when).toEqual({
      relations: { calls: { target_type: 'service-client' } },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses implies with object form and per-implies when', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies-when');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'reviewer:',
      '  type: llm',
      'implies:',
      '  - simple-aspect',
      '  - id: conditional-aspect',
      '    when:',
      '      node: { has_port: charge }',
    ].join('\n'), 'utf-8');

    const r = await parseAspect(tmpDir, aspectYaml, 'example');
    const aspect = assertOk(r);
    expect(aspect.implies).toEqual(['simple-aspect', 'conditional-aspect']);
    expect(aspect.impliesWhens).toEqual({
      'conditional-aspect': { node: { has_port: 'charge' } },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports invalid when at aspect level as a structured error, not a throw', async () => {
    // Must return {ok:false} with aspect-when-invalid — a throw would escape into
    // the loader and silently drop the aspect over a clean PASS.
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-when-bad');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'reviewer:',
      '  type: llm',
      'when:',
      '  mostly_of: []',
    ].join('\n'), 'utf-8');

    const result = await parseAspect(tmpDir, aspectYaml, 'example');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe('aspect-when-invalid');
      expect(result.errors[0].messageData.what).toMatch(/unknown when operator 'mostly_of'/);
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-string non-object entries in implies', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies-bad');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'reviewer:',
      '  type: llm',
      'implies:',
      '  - 42',
    ].join('\n'), 'utf-8');

    await expect(parseAspect(tmpDir, aspectYaml, 'example'))
      .rejects.toThrow(/aspect attachment must be a string or an object/);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('parseAspect v5 happy paths', () => {
  it('parses deterministic aspect with reviewer: { type: deterministic }', async () => {
    const dir = await newDir(`name: NoSyncFs\ndescription: x\nreviewer:\n  type: deterministic\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'no-sync-fs');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('deterministic');
      expect(r.aspect.reviewer.tier).toBeUndefined();
    }
  });

  it('parses LLM aspect with no tier', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: llm\n`, '# Foo\nrule.');
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer).toEqual({ type: 'llm' });
  });

  it('parses LLM aspect with tier', async () => {
    const dir = await newDir(`name: Bar\ndescription: x\nreviewer:\n  type: llm\n  tier: deep\n`, '# Bar\nrule.');
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'bar');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer).toEqual({ type: 'llm', tier: 'deep' });
  });
});

describe('parseAspect v5 error paths', () => {
  it('errors on missing reviewer block', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-missing')).toBe(true);
  });

  it('errors on reviewer: null', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
  });

  it('errors on missing type', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  tier: deep\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-type-missing')).toBe(true);
  });

  it('errors on invalid type value', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: foo\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-type-invalid')).toBe(true);
  });

  it('errors on deterministic + tier', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: deterministic\n  tier: deep\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-tier-on-deterministic')).toBe(true);
  });

  it('errors on aggregate + tier (an aggregate has no own reviewer)', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: aggregate\n  tier: deep\nimplies:\n  - other\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-tier-on-aggregate')).toBe(true);
  });

  it('errors on unknown reviewer key', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: llm\n  model: opus\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-unknown-key')).toBe(true);
  });

  it('emits both type-missing and unknown-key when mapping has unknown key but no type', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  model: opus\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.errors.map(e => e.code);
      expect(codes).toContain('aspect-reviewer-type-missing');
      expect(codes).toContain('aspect-reviewer-unknown-key');
    }
  });

  it('errors on empty mapping', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer: {}\n`);
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-type-missing')).toBe(true);
  });

  it('rejects a reference object whose description is not a string', async () => {
    const dir = await newDir(
      `name: Foo\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - path: foo.md\n    description: 123\n`,
      'rule',
    );
    const errors = assertFail(await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo'));
    expect(errors.some(e => e.code === 'aspect-reference-invalid-form')).toBe(true);
  });

  it('rejects a reference entry that is neither a string nor an object', async () => {
    const dir = await newDir(
      `name: Foo\ndescription: x\nreviewer:\n  type: llm\nreferences:\n  - 123\n`,
      'rule',
    );
    const errors = assertFail(await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo'));
    expect(errors.some(e => e.code === 'aspect-reference-invalid-form')).toBe(true);
  });

  it('rejects an empty-string reviewer.tier', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: llm\n  tier: ""\n`, 'rule');
    const errors = assertFail(await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo'));
    expect(errors.some(e => e.code === 'aspect-reviewer-tier-invalid')).toBe(true);
  });

  it('rejects a non-string reviewer.tier', async () => {
    const dir = await newDir(`name: Foo\ndescription: x\nreviewer:\n  type: llm\n  tier: 5\n`, 'rule');
    const errors = assertFail(await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'foo'));
    expect(errors.some(e => e.code === 'aspect-reviewer-tier-invalid')).toBe(true);
  });
});
