// The portal's PortalData source: concurrent requests share one extraction, and
// an unchanged project reuses the last one. Before, every /render and /data ran
// its own whole-project extraction (a page load plus a refresh ran two at once).

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPortalDataSource } from '../../src/portal/server/data-source.js';
import { portalStateKey as projectFingerprint } from '../../src/portal/state-key.js';
import type { PortalData } from '../../src/portal/contract.js';

function fakeExtract() {
  const calls: Array<(d: PortalData) => void> = [];
  const extract = (): Promise<PortalData> => new Promise<PortalData>((resolve) => { calls.push(resolve); });
  const settleAll = (tag: string) => { for (const r of calls.splice(0)) r({ tag } as unknown as PortalData); };
  return { extract, calls, settleAll };
}

describe('createPortalDataSource', () => {
  it('four concurrent requests run ONE extraction and all get its result', async () => {
    const fx = fakeExtract();
    let started = 0;
    const src = createPortalDataSource('/p', false, {
      extract: () => { started++; return fx.extract(); },
      fingerprint: async () => 'state-1',
    });
    const pending = [src.get(), src.get(), src.get(), src.get()];
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(1);
    fx.settleAll('A');
    const results = await Promise.all(pending);
    expect(results.map((d) => (d as unknown as { tag: string }).tag)).toEqual(['A', 'A', 'A', 'A']);
  });

  it('an unchanged project reuses the last extraction; a changed one extracts again', async () => {
    let state = 'state-1';
    let started = 0;
    const src = createPortalDataSource('/p', false, {
      extract: async () => ({ tag: `run-${++started}` } as unknown as PortalData),
      fingerprint: async () => state,
    });
    expect(await src.get()).toEqual({ tag: 'run-1' });
    expect(await src.get()).toEqual({ tag: 'run-1' });
    state = 'state-2';
    expect(await src.get()).toEqual({ tag: 'run-2' });
    expect(started).toBe(2);
  });

  it('without a fingerprint nothing is reused, but concurrent requests are still shared', async () => {
    const fx = fakeExtract();
    let started = 0;
    const src = createPortalDataSource('/p', false, {
      extract: () => { started++; return fx.extract(); },
      fingerprint: async () => null,
    });
    const both = [src.get(), src.get()];
    await new Promise((r) => setTimeout(r, 10));
    fx.settleAll('A');
    await Promise.all(both);
    expect(started).toBe(1);
    const later = src.get();
    await new Promise((r) => setTimeout(r, 10));
    fx.settleAll('B');
    expect(await later).toEqual({ tag: 'B' });
    expect(started).toBe(2);
  });

  it('a failed extraction is not cached: the next request tries again', async () => {
    let n = 0;
    const src = createPortalDataSource('/p', false, {
      extract: async () => { n++; if (n === 1) throw new Error('graph broken'); return { tag: 'ok' } as unknown as PortalData; },
      fingerprint: async () => 'same',
    });
    await expect(src.get()).rejects.toThrow('graph broken');
    expect(await src.get()).toEqual({ tag: 'ok' });
  });
});

describe('portalStateKey', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function gitRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-fp-'));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'one');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  it('is stable while nothing changes, and moves on every edit — including a second edit to an already-modified file', async () => {
    const dir = gitRepo();
    const clean = await projectFingerprint(dir);
    expect(clean).not.toBeNull();
    expect(await projectFingerprint(dir)).toBe(clean);

    writeFileSync(path.join(dir, 'src', 'a.ts'), 'two');
    const edited = await projectFingerprint(dir);
    expect(edited).not.toBe(clean);

    writeFileSync(path.join(dir, 'src', 'a.ts'), 'three!');
    utimesSync(path.join(dir, 'src', 'a.ts'), new Date(), new Date(Date.now() + 5000));
    expect(await projectFingerprint(dir)).not.toBe(edited);

    writeFileSync(path.join(dir, 'src', 'new.ts'), 'untracked');
    expect(await projectFingerprint(dir)).not.toBe(edited);
  });

  it('moves when the gitignored local deterministic lock changes', async () => {
    const dir = gitRepo();
    mkdirSync(path.join(dir, '.yggdrasil'));
    writeFileSync(path.join(dir, '.gitignore'), '.yggdrasil/.yg-lock.deterministic.json\n');
    const before = await projectFingerprint(dir);
    writeFileSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'), '{}');
    expect(await projectFingerprint(dir)).not.toBe(before);
  });

  it('is null outside a git repository (nothing is reused there)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-nogit-'));
    dirs.push(dir);
    expect(await projectFingerprint(dir)).toBeNull();
  });
});
