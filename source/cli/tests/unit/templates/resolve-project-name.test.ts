import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectName } from '../../../src/templates/default-config.js';

describe('resolveProjectName', () => {
  it('reads name from package.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ygg-name-'));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    expect(await resolveProjectName(dir)).toBe('my-app');
  });

  it('strips npm scope prefix', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ygg-name-'));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@org/my-app' }));
    expect(await resolveProjectName(dir)).toBe('my-app');
  });

  it('uses scope name when bare name is generic (root, app, main)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ygg-name-'));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@documenso/root' }));
    expect(await resolveProjectName(dir)).toBe('documenso');
  });

  it('falls back to directory name when no package.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ygg-name-'));
    expect(await resolveProjectName(dir)).toBe(path.basename(dir));
  });

  it('falls back to directory name when package.json has no name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ygg-name-'));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    expect(await resolveProjectName(dir)).toBe(path.basename(dir));
  });
});
