import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { atomicWriteFile } from '../../../src/io/atomic-write.js';

describe('atomicWriteFile', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'yg-atomic-'));
    dirs.push(d);
    return d;
  }

  it('writes content to non-existing file', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });

  it('overwrites existing file', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await readFile(target, 'utf-8')).toBe('new');
  });

  it('does not leave .tmp file behind on success', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await atomicWriteFile(target, 'hello');
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('uses a unique temp per write and cleans it up (no fixed-name collision)', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await atomicWriteFile(target, 'hello');
    const entries = await readdir(dir);
    // Exactly the target remains; the private temp was renamed away, and no
    // fixed `a.txt.tmp` is created (the old behaviour that raced under concurrency).
    expect(entries).toEqual(['a.txt']);
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });

  it('50 concurrent writers to the SAME target never ENOENT and leave a complete file', async () => {
    // Regression for the shared-cache/lock race: a fixed `<target>.tmp` collided
    // when parallel writers hit one file — one writer's rm/rename pulled the temp
    // out from under another, surfacing as ENOENT on rename. Unique temps fix it.
    const dir = await tempDir();
    const target = path.join(dir, 'shard.json');
    const payloads = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ n: i, pad: 'x'.repeat(2000) }),
    );
    await Promise.all(payloads.map((p) => atomicWriteFile(target, p)));
    const final = await readFile(target, 'utf-8');
    expect(() => JSON.parse(final)).not.toThrow(); // complete, never a partial write
    expect(payloads).toContain(final); // exactly one writer's content won
    const entries = await readdir(dir);
    expect(entries).toEqual(['shard.json']); // no leftover temps from any writer
  });

  it('creates parent directory if missing', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'nested/sub/a.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });
});
