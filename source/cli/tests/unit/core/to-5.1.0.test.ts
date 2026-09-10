import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migration } from '../../../src/migrations/to-5.1.0.js';
import { CLI_SUPPORTED_SCHEMA } from '../../../src/core/graph-loader.js';

describe('to-5.1.0 migration', () => {
  let base: string;
  let ygg: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'yg-mig51-'));
    ygg = path.join(base, '.yggdrasil');
    await mkdir(ygg, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('targets 5.1.0', () => {
    expect(migration.to).toBe('5.1.0');
  });

  it('targets a version strictly below the CLI-supported schema — the gap is now covered by the to-6.0.0 migration, not a version-lift', () => {
    // The 5.2.0 bump (this migration's target) deliberately left a gap with
    // no transforming migration of its own — a project landing here was
    // carried the rest of the way to 5.2.0 by the upgrade runner's
    // version-lift fallback. The 6.0.0 bump closes that gap: the registered
    // to-6.0.0 migration targets CLI_SUPPORTED_SCHEMA directly and applies to
    // any project below it, this one included, so the fallback is no longer
    // reached for a project starting here. Pinned here (where importing the
    // constant is legitimate) so the e2e upgrade test can stay a pure black
    // box.
    expect(migration.to).toBe('5.1.0');
    expect(CLI_SUPPORTED_SCHEMA).not.toBe(migration.to);
  });

  it('removes an existing schemas/ directory and reports an action', async () => {
    const schemasDir = path.join(ygg, 'schemas');
    await mkdir(schemasDir, { recursive: true });
    await writeFile(path.join(schemasDir, 'yg-node.yaml'), 'name: x\n', 'utf-8');

    const res = await migration.run(ygg);

    await expect(stat(schemasDir)).rejects.toThrow();
    expect(res.actions.join(' ')).toMatch(/schemas/);
    expect(res.warnings).toEqual([]);
  });

  it('is a no-op (no actions, no warnings) when schemas/ is absent', async () => {
    const res = await migration.run(ygg);
    expect(res.actions).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('is idempotent — a second run after removal still succeeds', async () => {
    await mkdir(path.join(ygg, 'schemas'), { recursive: true });
    await migration.run(ygg);
    await expect(migration.run(ygg)).resolves.toEqual({ actions: [], warnings: [] });
  });
});
