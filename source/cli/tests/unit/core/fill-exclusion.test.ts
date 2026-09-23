/**
 * One approval per repository at a time: a second `runFill` while one holds
 * the approval lock fails fast with an environment error instead of later
 * overwriting the first run's verdicts; a crashed run's lock does not block.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock, LockEnvironmentError, APPROVE_LOCK_FILE_NAME } from '../../../src/io/lock-store.js';

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';

async function setupProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-excl-'));
  const yggRoot = path.join(root, '.yggdrasil');
  await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n    log_required: false\n');
  await writeFile(path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'), 'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-pass\n');
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  const aspDir = path.join(yggRoot, 'aspects', 'det-pass');
  await mkdir(aspDir, { recursive: true });
  await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: det-pass\ndescription: d\nreviewer:\n  type: deterministic\nstatus: enforced\n');
  await writeFile(path.join(aspDir, 'check.mjs'), DET_PASS);
  return root;
}

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe('approval exclusion', () => {
  it('a second concurrent approval fails fast; the first completes and releases the lock', async () => {
    const root = await setupProject();
    dirs.push(root);
    const g1 = await loadGraph(root);
    const g2 = await loadGraph(root);
    const [a, b] = await Promise.allSettled([
      runFill(g1, { coverageVisibleFiles: null, write: () => {} }),
      runFill(g2, { coverageVisibleFiles: null, write: () => {} }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    const err = (b as PromiseRejectedResult).reason as InstanceType<typeof LockEnvironmentError>;
    expect(err).toBeInstanceOf(LockEnvironmentError);
    expect(err.code).toBe('approve-in-progress');
    expect(err.messageData.what).toMatch(/Another approval is already running/);
    expect(err.messageData.next).toMatch(/yg check --approve/);
    expect(readLock(g1.rootPath).verdicts['det-pass']?.['node:svc']?.verdict).toBe('approved');
    expect(existsSync(path.join(g1.rootPath, APPROVE_LOCK_FILE_NAME))).toBe(false);
  });

  it('a lock left behind by a run that crashed does not block the next one', async () => {
    const root = await setupProject();
    dirs.push(root);
    const g = await loadGraph(root);
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
    writeFileSync(path.join(g.rootPath, APPROVE_LOCK_FILE_NAME), JSON.stringify({ pid: dead, host: hostname(), startedAt: new Date().toISOString(), command: 'yg check --approve', token: 'x' }));
    await runFill(g, { coverageVisibleFiles: null, write: () => {} });
    expect(readLock(g.rootPath).verdicts['det-pass']?.['node:svc']?.verdict).toBe('approved');
  });

  it('a cost preview neither takes nor waits for the lock', async () => {
    const root = await setupProject();
    dirs.push(root);
    const g = await loadGraph(root);
    writeFileSync(path.join(g.rootPath, APPROVE_LOCK_FILE_NAME), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command: 'yg check --approve', token: 'x' }));
    await expect(runFill(g, { coverageVisibleFiles: null, write: () => {}, dryRun: true })).resolves.toBeDefined();
  });
});
