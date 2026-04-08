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
});
