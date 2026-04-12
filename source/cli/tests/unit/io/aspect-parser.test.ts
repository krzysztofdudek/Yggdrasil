import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAspect } from '../../../src/io/aspect-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  __dirname,
  '../../fixtures/sample-project/.yggdrasil/aspects/requires-audit',
);

describe('aspect-parser', () => {
  it('parses valid yg-aspect.yaml correctly', async () => {
    const aspect = await parseAspect(
      path.join(FIXTURE_DIR),
      path.join(FIXTURE_DIR, 'yg-aspect.yaml'),
      'requires-audit',
    );

    expect(aspect.name).toBe('Audit Logging');
    expect(aspect.id).toBe('requires-audit');
    expect(aspect.artifacts).toBeDefined();
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(badPath, '', 'utf-8');

    await expect(parseAspect(tmpDir, badPath, 'empty-aspect')).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(badPath, `implies: []\n`, 'utf-8');

    await expect(parseAspect(tmpDir, badPath, 'some-aspect')).rejects.toThrow(
      "missing or empty 'name'",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses id from directory path (3rd parameter)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-tag');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: My Aspect\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'my-directory-name');
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
      `name: HIPAA
implies:
  - requires-audit
  - requires-encryption
`,
      'utf-8',
    );
    const aspect = await parseAspect(tmpDir, aspectPath, 'requires-hipaa');
    expect(aspect.id).toBe('requires-hipaa');
    expect(aspect.implies).toEqual(['requires-audit', 'requires-encryption']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when id is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty-id');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\n`, 'utf-8');

    await expect(parseAspect(tmpDir, aspectPath, '')).rejects.toThrow(
      'aspect id must be non-empty',
    );
    await expect(parseAspect(tmpDir, aspectPath, '   ')).rejects.toThrow(
      'aspect id must be non-empty',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when implies is not an array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-bad-implies');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nimplies: "not-an-array"\n`, 'utf-8');

    await expect(parseAspect(tmpDir, aspectPath, 'bad-implies')).rejects.toThrow(
      "'implies' must be an array of strings",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults optional fields when missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Minimal Aspect\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'minimal-aspect');
    expect(aspect.name).toBe('Minimal Aspect');
    expect(aspect.id).toBe('minimal-aspect');
    expect(aspect.artifacts).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('silently ignores unknown stability field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-stability');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Stable Aspect\nstability: protocol\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'stable');
    // unknown field should not throw
    expect(aspect.name).toBe('Stable Aspect');
    expect((aspect as Record<string, unknown>).stability).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('silently ignores unknown anchors field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-anchors');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: Logging
anchors:
  - id: audit-entry
    claim: "All mutations record an audit entry"
`,
      'utf-8',
    );

    const aspect = await parseAspect(tmpDir, aspectPath, 'logging');
    expect(aspect.name).toBe('Logging');
    expect((aspect as Record<string, unknown>).anchors).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses all optional fields together', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-full');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: Full Aspect
description: A fully specified aspect
implies:
  - other-aspect
`,
      'utf-8',
    );

    const aspect = await parseAspect(tmpDir, aspectPath, 'full-aspect');
    expect(aspect.name).toBe('Full Aspect');
    expect(aspect.description).toBe('A fully specified aspect');
    expect(aspect.implies).toEqual(['other-aspect']);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
