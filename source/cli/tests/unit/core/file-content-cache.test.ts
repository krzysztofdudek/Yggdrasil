import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileContentCache } from '../../../src/io/file-content-cache.js';

describe('FileContentCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fcc-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads small text file', async () => {
    const path = join(tmpDir, 'small.txt');
    writeFileSync(path, 'hello world');
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.content).toBe('hello world');
    expect(result.isBinary).toBe(false);
    expect(result.tooLarge).toBe(false);
  });

  it('caches reads (returns same object reference)', async () => {
    const path = join(tmpDir, 'cached.txt');
    writeFileSync(path, 'content');
    const cache = new FileContentCache();
    const r1 = await cache.read(path);
    const r2 = await cache.read(path);
    expect(r1).toBe(r2);
  });

  it('detects binary via null bytes in first 8KB', async () => {
    const path = join(tmpDir, 'binary.bin');
    const buf = Buffer.concat([
      Buffer.from('hello'),
      Buffer.from([0x00, 0x01]),
      Buffer.from('world'),
    ]);
    writeFileSync(path, buf);
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.isBinary).toBe(true);
    expect(result.content).toBeUndefined();
  });

  it('flags files over 5MB as tooLarge', async () => {
    const path = join(tmpDir, 'big.txt');
    writeFileSync(path, 'a'.repeat(5 * 1024 * 1024 + 1));
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.tooLarge).toBe(true);
    expect(result.isBinary).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it('detects binary via null bytes even when the file is over 5MB — binary wins over the size guard', async () => {
    // Before the fix, the size check ran BEFORE binary detection, so a >5MB
    // binary was reported tooLarge (blocking, unreadable) instead of isBinary
    // (a deliberate, never-blocking non-match). The null byte sits within the
    // first probe window (BINARY_PROBE_BYTES), which is all binary detection
    // ever reads — the multi-megabyte tail is never loaded to answer this.
    const path = join(tmpDir, 'big.bin');
    const buf = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)]);
    writeFileSync(path, buf);
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.isBinary).toBe(true);
    expect(result.tooLarge).toBe(false);
    expect(result.unreadable).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it('a >5MB file with no null byte anywhere in the probe window is still tooLarge, not binary', async () => {
    const path = join(tmpDir, 'big-text.txt');
    // Genuinely text throughout — including the first BINARY_PROBE_BYTES.
    writeFileSync(path, 'a'.repeat(5 * 1024 * 1024 + 1));
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.isBinary).toBe(false);
    expect(result.tooLarge).toBe(true);
  });

  it('reports unreadable files', async () => {
    const cache = new FileContentCache();
    const result = await cache.read(join(tmpDir, 'nonexistent.txt'));
    expect(result.unreadable).toBe(true);
    expect(result.content).toBeUndefined();
    expect(result.unreadableReason).toMatch(/ENOENT/);
  });

  it('captures OS error message for unreadable files', async () => {
    const cache = new FileContentCache();
    const result = await cache.read(join(tmpDir, 'missing-X.txt'));
    expect(result.unreadable).toBe(true);
    expect(result.unreadableReason).toBeDefined();
    expect(typeof result.unreadableReason).toBe('string');
  });

  it('reports unreadable when readFile fails after stat succeeds (broken symlink)', async () => {
    const target = join(tmpDir, 'real.txt');
    const link = join(tmpDir, 'link.txt');
    writeFileSync(target, 'data');
    const fs = await import('node:fs');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target);
    const cache = new FileContentCache();
    const result = await cache.read(link);
    expect(result.unreadable).toBe(true);
    expect(result.unreadableReason).toBeDefined();
  });
});
