import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCtxParsers, prewarmupAstCache, enrichFilesWithAst } from '../../../src/structure/ctx-parsers.js';
import { UndeclaredFsReadError } from '../../../src/structure/ctx-fs.js';
import { ObservationRecorder } from '../../../src/structure/observations.js';
import { observationKey, MISSING_OBSERVATION } from '../../../src/core/pair-hash.js';

describe('ctx parsers', () => {
  let root: string;
  let touched: string[];
  // Allow-set for string-path reads. cfg.json is the one legit string read in
  // these tests; File-object inputs bypass the allow-set entirely.
  const allowedSet = new Set(['cfg.json']);
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'yg-ctx-parsers-')); touched = []; });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('parseYaml on File entry', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseYaml({ path: 'x.yaml', content: 'foo: bar' })).toEqual({ foo: 'bar' });
    expect(touched).toContain('x.yaml');
  });

  it('parseJson on File entry', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseJson({ path: 'x.json', content: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('parseToml on File entry', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseToml({ path: 'x.toml', content: 'name = "yg"' })).toEqual({ name: 'yg' });
  });

  it('parseAst on File entry returns tree-sitter Tree synchronously from prewarmed cache', async () => {
    const astCache = new Map();
    const { parseFile } = await import('../../../src/ast/parser.js');
    const tree = await parseFile('x.ts', 'const x = 1;');
    astCache.set('x.ts', { content: 'const x = 1;', ast: tree });

    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache });
    const got = p.parseAst({ path: 'x.ts', content: 'const x = 1;' }, 'typescript');
    expect((got as any).rootNode).toBeDefined();
  });

  it('parseAst throws structure-aspect-parseast-not-prewarmed on cache miss', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseAst({ path: 'unknown.ts', content: 'x' }, 'typescript'))
      .toThrow(/structure-aspect-parseast-not-prewarmed/);
  });

  it('parser accepts allowed path string and reads + tracks', () => {
    writeFileSync(path.join(root, 'cfg.json'), '{"k":2}');
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseJson('cfg.json')).toEqual({ k: 2 });
    expect(touched).toContain('cfg.json');
  });

  // Sandbox holes: a string path must be routed through the same allow-set
  // guard ctx.fs uses. Absolute paths and parent-directory traversal that
  // escapes the repo must be rejected — they let untrusted check.mjs read
  // arbitrary files (e.g. /etc/passwd) outside the declared read set.
  it('parseJson rejects absolute path outside allow-set', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseJson('/etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('parseYaml rejects absolute path outside allow-set', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseYaml('/etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('parseToml rejects absolute path outside allow-set', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseToml('/etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('parseJson rejects parent-directory traversal that escapes the repo', () => {
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseJson('cfg.json/../../../../etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('parseJson rejects a path not in the allow-set even if it resolves inside the repo', () => {
    writeFileSync(path.join(root, 'secret.json'), '{"s":1}');
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseJson('secret.json')).toThrow(UndeclaredFsReadError);
  });

  // ── recorder wiring on a string-path read (spec §3.1) ──────────────────────

  it('records a read: observation for a string-path parse when a recorder is supplied', () => {
    writeFileSync(path.join(root, 'cfg.json'), '{"k":2}');
    const recorder = new ObservationRecorder();
    const p = createCtxParsers({ allowedSet, projectRoot: root, touchedFiles: touched, astCache: new Map(), recorder });
    expect(p.parseJson('cfg.json')).toEqual({ k: 2 });
    const snap = recorder.snapshot();
    const key = observationKey('read', 'cfg.json');
    expect(snap.some(([k, h]) => k === key && h !== MISSING_OBSERVATION)).toBe(true);
  });

  it('does NOT record an observation when the string path is already a subject file', () => {
    writeFileSync(path.join(root, 'cfg.json'), '{"k":2}');
    const recorder = new ObservationRecorder();
    const p = createCtxParsers({
      allowedSet,
      projectRoot: root,
      touchedFiles: touched,
      astCache: new Map(),
      recorder,
      subjectFiles: new Set(['cfg.json']),
    });
    expect(p.parseJson('cfg.json')).toEqual({ k: 2 });
    expect(recorder.snapshot()).toHaveLength(0);
  });

  it('over-records a MISSING read observation when an allowed string path throws on read', () => {
    // 'ghost.json' passes the allow-check but is never written to disk — the read
    // itself throws (ENOENT), and with a recorder present that throw must still
    // fold an absent observation before rethrowing (over-record, spec §3.1).
    const recorder = new ObservationRecorder();
    const p = createCtxParsers({
      allowedSet: new Set(['ghost.json']),
      projectRoot: root,
      touchedFiles: touched,
      astCache: new Map(),
      recorder,
    });
    expect(() => p.parseJson('ghost.json')).toThrow();
    const snap = recorder.snapshot();
    const key = observationKey('read', 'ghost.json');
    expect(snap.some(([k, h]) => k === key && h === MISSING_OBSERVATION)).toBe(true);
  });

  it('does NOT record a MISSING observation on a throwing read when the path is a subject file', () => {
    const recorder = new ObservationRecorder();
    const p = createCtxParsers({
      allowedSet: new Set(['ghost.json']),
      projectRoot: root,
      touchedFiles: touched,
      astCache: new Map(),
      recorder,
      subjectFiles: new Set(['ghost.json']),
    });
    expect(() => p.parseJson('ghost.json')).toThrow();
    expect(recorder.snapshot()).toHaveLength(0);
  });
});

describe('enrichFilesWithAst', () => {
  it('attaches language + the prewarmed ast when the cached content matches', async () => {
    const astCache = new Map();
    const files = [{ path: 'a.ts', content: 'const a = 1;' }];
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });

    const enriched = enrichFilesWithAst(files, astCache);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].language).toBe('typescript');
    expect(enriched[0].ast).toBeDefined();
  });

  it('leaves ast undefined when the cached entry\'s content no longer matches (stale cache)', async () => {
    const astCache = new Map();
    const files = [{ path: 'a.ts', content: 'const a = 1;' }];
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });

    // Re-enrich with DIFFERENT content for the same path — the cache entry is stale.
    const changed = [{ path: 'a.ts', content: 'const a = 2; // changed' }];
    const enriched = enrichFilesWithAst(changed, astCache);
    expect(enriched[0].ast).toBeUndefined();
    expect(enriched[0].language).toBe('typescript'); // language comes from the extension, not the cache
  });

  it('leaves both language and ast undefined for a file with no registered grammar', () => {
    const enriched = enrichFilesWithAst([{ path: 'b.swift', content: 'let b = 1' }], new Map());
    expect(enriched[0].language).toBeUndefined();
    expect(enriched[0].ast).toBeUndefined();
  });
});

describe('prewarmupAstCache', () => {
  it('populates astCache for TS files and skips non-AST files', async () => {
    const astCache = new Map();
    const files = [
      { path: 'a.ts', content: 'const a = 1;' },
      { path: 'b.swift', content: 'let b = 1' },
    ];
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });
    expect(astCache.has('a.ts')).toBe(true);
    expect(astCache.get('a.ts')!.content).toBe('const a = 1;');
    // .swift has no registered grammar — it is skipped (no parse tree cached).
    expect(astCache.has('b.swift')).toBe(false);
  });

  it('skips re-parsing when cache entry matches content', async () => {
    const astCache = new Map();
    const files = [{ path: 'x.ts', content: 'const x = 1;' }];
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });
    const first = astCache.get('x.ts');
    // Run again — should reuse existing cache entry (same object reference)
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });
    expect(astCache.get('x.ts')).toBe(first);
  });
});
