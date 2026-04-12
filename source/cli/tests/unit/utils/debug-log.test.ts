import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDebugLog, debugWrite, _resetForTesting } from '../../../src/utils/debug-log.js';

describe('debug-log', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-debug-'));
  });

  afterEach(() => {
    _resetForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('debugWrite before init does not throw and creates no file', () => {
    expect(() => debugWrite('hello')).not.toThrow();
    expect(existsSync(path.join(tmpDir, '.debug.log'))).toBe(false);
  });

  it('initDebugLog with enabled=false creates no file', () => {
    initDebugLog(tmpDir, false);
    expect(existsSync(path.join(tmpDir, '.debug.log'))).toBe(false);
  });

  it('initDebugLog with enabled=true creates log with header', () => {
    initDebugLog(tmpDir, true);
    const logPath = path.join(tmpDir, '.debug.log');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('═');
    expect(content).toContain('yg ');
  });

  it('debugWrite after init appends to log', () => {
    initDebugLog(tmpDir, true);
    debugWrite('test message');
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('test message');
  });

  it('tee: stdout content appears in log', () => {
    initDebugLog(tmpDir, true);
    // After init, process.stdout.write is teed — write to it
    process.stdout.write('stdout-capture-test\n');
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('stdout-capture-test');
  });

  it('tee: first stderr preceded by [stderr] header', () => {
    initDebugLog(tmpDir, true);
    process.stderr.write('first-error\n');
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('[stderr]');
    expect(content).toContain('first-error');
    // [stderr] header should appear before the error content
    const stderrIdx = content.indexOf('[stderr]');
    const errorIdx = content.indexOf('first-error');
    expect(stderrIdx).toBeLessThan(errorIdx);
  });

  it('tee: [stderr] header appears only once', () => {
    initDebugLog(tmpDir, true);
    process.stderr.write('error-one\n');
    process.stderr.write('error-two\n');
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    const matches = content.match(/\[stderr\]/g);
    expect(matches).toHaveLength(1);
  });

  it('initDebugLog called twice — second call is a no-op', () => {
    initDebugLog(tmpDir, true);
    const logPath = path.join(tmpDir, '.debug.log');
    const contentAfterFirst = readFileSync(logPath, 'utf-8');

    // Second call with a DIFFERENT directory — if it were not a no-op,
    // a new log would be created there. Instead, nothing should change.
    const tmpDir2 = mkdtempSync(path.join(os.tmpdir(), 'yg-debug2-'));
    try {
      initDebugLog(tmpDir2, true);
      // The second call must be a no-op: original log is unchanged (no second header written)
      const contentAfterSecond = readFileSync(logPath, 'utf-8');
      expect(contentAfterSecond).toBe(contentAfterFirst);
      // The second dir should NOT have a log file created
      expect(existsSync(path.join(tmpDir2, '.debug.log'))).toBe(false);
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('tee: Uint8Array chunk is converted to string and written to log', () => {
    initDebugLog(tmpDir, true);
    const chunk = Buffer.from('uint8-test\n', 'utf-8');
    process.stdout.write(chunk);
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('uint8-test');
  });

  it('tee: Uint8Array chunk on stderr is converted and written with header', () => {
    initDebugLog(tmpDir, true);
    const chunk = Buffer.from('uint8-stderr\n', 'utf-8');
    process.stderr.write(chunk);
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('[stderr]');
    expect(content).toContain('uint8-stderr');
  });

  it('exit handler writes [exit N] for non-zero exit code', () => {
    initDebugLog(tmpDir, true);
    // Trigger the exit handler directly by emitting the exit event
    process.emit('exit', 1);
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('[exit 1]');
  });

  it('tee: Uint8Array chunk on stdout is converted and written', () => {
    initDebugLog(tmpDir, true);
    const chunk = Buffer.from('uint8-test\n', 'utf-8');
    process.stdout.write(chunk);
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).toContain('uint8-test');
  });

  it('exit handler does NOT write [exit N] for code 0', () => {
    initDebugLog(tmpDir, true);
    process.emit('exit', 0);
    const content = readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
    expect(content).not.toContain('[exit 0]');
    // But a trailing newline is still appended
    expect(content.endsWith('\n')).toBe(true);
  });
});
