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
  it('parses valid aspect.yaml correctly', async () => {
    const aspect = await parseAspect(
      path.join(FIXTURE_DIR),
      path.join(FIXTURE_DIR, 'aspect.yaml'),
      'requires-audit',
    );

    expect(aspect.name).toBe('Audit Logging');
    expect(aspect.id).toBe('requires-audit');
    expect(aspect.artifacts).toBeDefined();
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'aspect.yaml');
    await writeFile(badPath, '', 'utf-8');

    await expect(parseAspect(tmpDir, badPath, 'empty-aspect')).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'aspect.yaml');
    await writeFile(badPath, `implies: []\n`, 'utf-8');

    await expect(parseAspect(tmpDir, badPath, 'some-aspect')).rejects.toThrow(
      "missing or empty 'name'",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses id from directory path (3rd parameter)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-tag');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'aspect.yaml');
    await writeFile(aspectPath, `name: My Aspect\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'my-directory-name');
    expect(aspect.id).toBe('my-directory-name');
    expect(aspect.name).toBe('My Aspect');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses implies when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'aspect.yaml');
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

  it('defaults optional fields when missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'aspect.yaml');
    await writeFile(aspectPath, `name: Minimal Aspect\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'minimal-aspect');
    expect(aspect.name).toBe('Minimal Aspect');
    expect(aspect.id).toBe('minimal-aspect');
    expect(aspect.artifacts).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
