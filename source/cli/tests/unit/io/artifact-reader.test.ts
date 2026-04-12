import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArtifacts } from '../../../src/io/artifact-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BASE = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil');

describe('artifact-reader', () => {
  it('reads all .md files from a directory', async () => {
    const dir = path.join(FIXTURE_BASE, 'aspects/requires-logging');
    const artifacts = await readArtifacts(dir);

    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    expect(artifacts.some((a) => a.filename === 'content.md')).toBe(true);
  });

  it('excludes yg-aspect.yaml by default', async () => {
    const dir = path.join(FIXTURE_BASE, 'aspects/requires-logging');
    const artifacts = await readArtifacts(dir, ['yg-aspect.yaml']);

    expect(artifacts.every((a) => a.filename !== 'yg-aspect.yaml')).toBe(true);
    expect(artifacts.some((a) => a.filename === 'content.md')).toBe(true);
  });

  it('reads only includeFiles when specified', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-artifacts');
    await mkdir(tmpDir, { recursive: true });

    await writeFile(path.join(tmpDir, 'readme.md'), '# Readme', 'utf-8');
    await writeFile(path.join(tmpDir, 'other.md'), '# Other', 'utf-8');
    await writeFile(path.join(tmpDir, 'notes.txt'), 'Notes', 'utf-8');

    const artifacts = await readArtifacts(tmpDir, [], ['readme.md']);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filename).toBe('readme.md');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns artifacts sorted by filename', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-artifacts-sort');
    await mkdir(tmpDir, { recursive: true });

    await writeFile(path.join(tmpDir, 'zeta.md'), 'z', 'utf-8');
    await writeFile(path.join(tmpDir, 'alpha.md'), 'a', 'utf-8');

    const artifacts = await readArtifacts(tmpDir);
    const filenames = artifacts.map((a) => a.filename);
    expect(filenames).toEqual(['alpha.md', 'zeta.md']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty for missing directory', async () => {
    const artifacts = await readArtifacts('/nonexistent/path');
    expect(artifacts).toEqual([]);
  });
});
