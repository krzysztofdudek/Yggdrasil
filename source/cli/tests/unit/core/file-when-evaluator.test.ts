import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateFileWhen } from '../../../src/core/file-when-evaluator.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import type { FileWhenPredicate } from '../../../src/model/file-when.js';

describe('evaluateFileWhen', () => {
  let tmpDir: string;
  let cache: FileContentCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fwe-'));
    cache = new FileContentCache();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function ctx(filePath: string) {
    return {
      absPath: join(tmpDir, filePath),
      repoRelPath: filePath,
      projectRoot: tmpDir,
      cache,
    };
  }

  it('path atom matches glob', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const pred: FileWhenPredicate = { path: '*.ts' };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
    expect(result.trace.kind).toBe('atom-path');
  });

  it('path atom does not match different glob', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const pred: FileWhenPredicate = { path: '*.py' };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(false);
  });

  it('content atom matches regex', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'function registerLogCommand() {}');
    const pred: FileWhenPredicate = { content: 'register[A-Z]\\w*Command' };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
  });

  it('content atom returns false on binary file and is NOT flagged unreadable (legitimate non-match)', async () => {
    // Deliberate asymmetry: a binary file has no text for a text content regex
    // to match, so it is a legitimate non-match — excluded, never blocking.
    writeFileSync(join(tmpDir, 'bin'), Buffer.from([0x00, 0x01, 0x02]));
    const pred: FileWhenPredicate = { content: '.' };
    const result = await evaluateFileWhen(pred, ctx('bin'));
    expect(result.result).toBe(false);
    expect(result.unreadable).toBeUndefined();
    expect((result.trace as { detail?: string }).detail).toMatch(/binary/i);
  });

  it('all_of requires every child', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'foo');
    const pred: FileWhenPredicate = {
      all_of: [{ path: '*.ts' }, { content: 'bar' }],
    };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(false);
    expect(result.trace.kind).toBe('all_of');
  });

  it('any_of needs only one child', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'foo');
    const pred: FileWhenPredicate = {
      any_of: [{ path: '*.py' }, { content: 'foo' }],
    };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
  });

  it('not inverts child', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const pred: FileWhenPredicate = { not: { path: '*.py' } };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
  });

  it('auto-exempts paths under .yggdrasil/', async () => {
    const pred: FileWhenPredicate = { path: 'something-else.ts' };
    const result = await evaluateFileWhen(pred, ctx('.yggdrasil/model/foo.yaml'));
    expect(result.result).toBe(true);
    expect(result.trace.kind).toBe('exempt');
  });

  it('returns trace structure matching spec', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'foo');
    const pred: FileWhenPredicate = {
      all_of: [{ path: '*.ts' }, { content: 'bar' }],
    };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    const trace = result.trace as {
      kind: string;
      children: Array<{ kind: string; result: boolean }>;
    };
    expect(trace.kind).toBe('all_of');
    expect(trace.children).toHaveLength(2);
    expect(trace.children[0].kind).toBe('atom-path');
    expect(trace.children[0].result).toBe(true);
    expect(trace.children[1].kind).toBe('atom-content');
    expect(trace.children[1].result).toBe(false);
  });

  it('propagates unreadable flag through all_of when child file unreadable', async () => {
    const target = join(tmpDir, 'gone.ts');
    const link = join(tmpDir, 'src.ts');
    writeFileSync(target, '');
    const fs = await import('node:fs');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target);
    const pred: FileWhenPredicate = { all_of: [{ path: '*.ts' }, { content: 'foo' }] };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.unreadable).toBe(true);
    expect(result.unreadableReason).toMatch(/ENOENT|broken/i);
  });

  it('path matching is case-sensitive on all platforms', async () => {
    writeFileSync(join(tmpDir, 'Src.ts'), '');
    const pred: FileWhenPredicate = { path: 'src.ts' };
    const result = await evaluateFileWhen(pred, ctx('Src.ts'));
    expect(result.result).toBe(false);
  });

  it('content: ".*" trivial regex is accepted', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'anything');
    const pred: FileWhenPredicate = { content: '.*' };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
  });

  it('rejects head-limited content gracefully', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'a'.repeat(300 * 1024));
    const pred: FileWhenPredicate = { content: 'a' };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
  });

  it('treats atomic with both path and content as implicit all_of', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), 'matching body');
    const pred: FileWhenPredicate = { path: '*.ts', content: 'matching' };
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(true);
    expect(result.trace.kind).toBe('all_of');
  });

  it('content predicate on file >5MB is flagged unreadable (too-large) so the caller can block it', async () => {
    // Deliberate asymmetry vs. binary: a too-large file CANNOT be scanned, so the
    // filter is unevaluable — it must NOT be silently excluded (vacuous green).
    // It signals unreadable: true (kind too-large) so the caller records it in the
    // blocking unreadable[] channel, exactly like an EACCES read failure.
    writeFileSync(join(tmpDir, 'big.ts'), 'a'.repeat(5 * 1024 * 1024 + 1));
    const pred: FileWhenPredicate = { content: 'a' };
    const result = await evaluateFileWhen(pred, ctx('big.ts'));
    expect(result.result).toBe(false);
    expect(result.unreadable).toBe(true);
    expect(result.unreadableKind).toBe('too-large');
    expect(result.unreadableReason).toMatch(/5MB/);
    expect((result.trace as { detail?: string }).detail).toMatch(/5MB/);
  });

  it('all_of short-circuits to a clean non-match when a definitively-false sibling makes the whole predicate unmatchable, even though another child is unreadable', async () => {
    const target = join(tmpDir, 'gone.ts');
    const link = join(tmpDir, 'other.ts');
    writeFileSync(target, '');
    const fs = await import('node:fs');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target);
    // path 'src/**' does not match 'other.ts' — definitively false — so the
    // all_of can never match regardless of what the (also unreadable) content
    // atom would have resolved to.
    const pred: FileWhenPredicate = { all_of: [{ path: 'src/**' }, { content: 'foo' }] };
    const result = await evaluateFileWhen(pred, ctx('other.ts'));
    expect(result.result).toBe(false);
    expect(result.unreadable).toBeUndefined();
  });

  it('{ path, content } desugars to all_of, so a non-matching path also short-circuits an unreadable content atom to a clean non-match', async () => {
    const target = join(tmpDir, 'gone.ts');
    const link = join(tmpDir, 'wrong-name.ts');
    writeFileSync(target, '');
    const fs = await import('node:fs');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target);
    const pred: FileWhenPredicate = { path: 'src/**', content: 'foo' };
    const result = await evaluateFileWhen(pred, ctx('wrong-name.ts'));
    expect(result.result).toBe(false);
    expect(result.unreadable).toBeUndefined();
  });

  it('all_of still propagates unreadable when the ONLY definitively-resolved siblings are true (the match genuinely hinges on the unreadable atom)', async () => {
    // Regression guard for the fix above: a TRUE sibling must not suppress
    // propagation the way a FALSE one correctly does.
    const target = join(tmpDir, 'gone.ts');
    const link = join(tmpDir, 'src.ts');
    writeFileSync(target, '');
    const fs = await import('node:fs');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target);
    const pred: FileWhenPredicate = { all_of: [{ path: '*.ts' }, { content: 'foo' }] };
    const result = await evaluateFileWhen(pred, ctx('src.ts')); // path matches — true
    expect(result.unreadable).toBe(true);
  });

  it('a >5MB binary file under a content-only atom is a clean non-match, not unreadable, at the raw evaluator level', async () => {
    const buf = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)]);
    writeFileSync(join(tmpDir, 'big.bin'), buf);
    const pred: FileWhenPredicate = { content: 'a' };
    const result = await evaluateFileWhen(pred, ctx('big.bin'));
    expect(result.result).toBe(false);
    expect(result.unreadable).toBeUndefined();
    expect((result.trace as { detail?: string }).detail).toMatch(/binary/);
  });

  it('any_of keeps the first unreadable reason when multiple children unreadable', async () => {
    const pred: FileWhenPredicate = {
      any_of: [{ content: 'a' }, { content: 'b' }],
    };
    const result = await evaluateFileWhen(pred, ctx('missing.ts'));
    expect(result.result).toBe(false);
    expect(result.unreadable).toBe(true);
    expect(result.unreadableReason).toMatch(/ENOENT/);
  });

  it('returns false with empty-atomic trace for malformed predicate (defensive)', async () => {
    writeFileSync(join(tmpDir, 'src.ts'), '');
    const pred = {} as FileWhenPredicate;
    const result = await evaluateFileWhen(pred, ctx('src.ts'));
    expect(result.result).toBe(false);
    expect((result.trace as { detail?: string }).detail).toBe('empty atomic');
  });
});
