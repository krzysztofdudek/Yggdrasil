import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCtxFs, UndeclaredFsReadError } from '../../../src/structure/ctx-fs.js';
import { ObservationRecorder } from '../../../src/structure/observations.js';

/**
 * Branch-coverage tests for the ctx.fs sandbox: the empty-path allow guard, and the
 * over-record paths where an ALLOWED read/list throws (missing file/dir) — the recorder
 * must fold an ABSENT observation before re-throwing, so a check that swallows the throw
 * and treats the path as absent still invalidates once the path later appears. Also the
 * positive existence-probe observation recorded on a successful exists().
 */

describe('ctx.fs — allow guard and over-record paths', () => {
  let root: string;
  // Includes two ALLOWED paths that are intentionally NOT created on disk.
  const allowedSet = new Set(['src/foo.ts', 'src/gone.ts', 'src/emptydir']);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-ctxfs-bc-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/foo.ts'), 'foo');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rejects an empty path (never allowed)', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: [] });
    expect(() => fs.exists('')).toThrow(UndeclaredFsReadError);
  });

  it('records a positive existence probe when a recorder is provided', () => {
    const recorder = new ObservationRecorder();
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: [], recorder });
    expect(fs.exists('src/foo.ts')).toBe('file');
    expect(recorder.snapshot().some(([k]) => k.includes('foo.ts'))).toBe(true);
  });

  it('folds an ABSENT read observation and re-throws when an allowed file is missing', () => {
    const recorder = new ObservationRecorder();
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: [], recorder });
    expect(() => fs.read('src/gone.ts')).toThrow();
    expect(recorder.snapshot().some(([k]) => k.includes('gone.ts'))).toBe(true);
  });

  it('folds an ABSENT list observation and re-throws when an allowed dir is missing', () => {
    const recorder = new ObservationRecorder();
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: [], recorder });
    expect(() => fs.list('src/emptydir')).toThrow();
    expect(recorder.snapshot().some(([k]) => k.includes('emptydir'))).toBe(true);
  });
});
