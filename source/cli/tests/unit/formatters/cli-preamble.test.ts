import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from '../../../src/cli/preamble.js';

describe('loadGraphOrAbort', () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-preamble-'));
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('__exit__');
      }) as never);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the loaded graph when .yggdrasil/ exists and is valid', async () => {
    const ygg = join(dir, '.yggdrasil');
    mkdirSync(join(ygg, 'model'), { recursive: true });
    writeFileSync(
      join(ygg, 'yg-config.yaml'),
      `version: "6.0.0"\nschemaVersion: "4.3.0"\nproject:\n  name: t\n`,
    );
    writeFileSync(join(ygg, 'yg-architecture.yaml'), 'node_types: {}\n');

    const graph = await loadGraphOrAbort(dir, { tolerateInvalidConfig: true });
    expect(graph).toBeDefined();
    expect(graph.rootPath.endsWith('.yggdrasil')).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 with structured what/why/next when .yggdrasil/ is absent', async () => {
    await expect(loadGraphOrAbort(dir)).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).toContain('No .yggdrasil/ directory found');
    expect(written).toContain("'yg init'");
  });

  it('loads a graph with a malformed flow and reports the flow as not loaded, NOT "run yg init" and NOT a stop', async () => {
    const ygg = join(dir, '.yggdrasil');
    mkdirSync(join(ygg, 'model'), { recursive: true });
    writeFileSync(join(ygg, 'yg-config.yaml'), `version: "6.0.0"\nschemaVersion: "4.3.0"\nproject:\n  name: t\n`);
    writeFileSync(join(ygg, 'yg-architecture.yaml'), 'node_types: {}\n');
    // A flow directory whose yg-flow.yaml is absent → ENOENT during load. The
    // graph IS initialized, and one flow is one flow's finding: the graph loads,
    // with the flow recorded as not loaded, and nothing exits.
    mkdirSync(join(ygg, 'flows', 'broken'), { recursive: true });

    const graph = await loadGraphOrAbort(dir, { tolerateInvalidConfig: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(graph.flows).toEqual([]);
    expect(graph.flowParseErrors?.map((e) => e.flowPath)).toEqual(['broken']);
    expect(graph.flowParseErrors?.[0].messageData.what).toContain('has no yg-flow.yaml file');
  });

  it('abortOnUnexpectedError writes structured message and exits 1', () => {
    expect(() => abortOnUnexpectedError(new Error('boom'), 'doing stuff')).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).toContain('Unexpected error while doing stuff: boom');
    expect(written).toContain('file an issue');
  });

  it('abortOnUnexpectedError handles non-Error inputs by stringifying them', () => {
    expect(() => abortOnUnexpectedError('plain string', 'loading')).toThrow('__exit__');
    const written = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).toContain('Unexpected error while loading: plain string');
  });

  it('exits 1 with a clean (non-bug) message when config schema is newer than the CLI', async () => {
    const ygg = join(dir, '.yggdrasil');
    mkdirSync(join(ygg, 'model'), { recursive: true });
    writeFileSync(join(ygg, 'yg-config.yaml'), `version: "99.0.0"\n`);
    writeFileSync(join(ygg, 'yg-architecture.yaml'), 'node_types: {}\n');

    await expect(loadGraphOrAbort(dir, { tolerateInvalidConfig: true })).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).toContain('newer than this CLI supports');
    expect(written).toContain('max: 6.0.0');
    expect(written).toContain('99.0.0');
    // Expected user error (upgrade your CLI), not an internal bug.
    expect(written).not.toContain('file an issue');
    expect(written).not.toContain('This is a bug');
  });

  it('rethrows non-ENOENT errors so callers can decide', async () => {
    const ygg = join(dir, '.yggdrasil');
    mkdirSync(ygg, { recursive: true });
    // model/ directory missing but .yggdrasil/ exists — loader emits "does not exist"
    // which loadGraphOrAbort treats as missing-graph and exits 1. To get a true
    // pass-through error we point at a syntactically broken yg-config and disable
    // tolerateInvalidConfig.
    mkdirSync(join(ygg, 'model'));
    writeFileSync(join(ygg, 'yg-config.yaml'), 'version: "6.0.0"\nthis is :: not valid yaml :::');

    // Loader rejects bad config when tolerateInvalidConfig is false.
    // The error is not ENOENT-shaped, so loadGraphOrAbort should rethrow.
    await expect(loadGraphOrAbort(dir, { tolerateInvalidConfig: false })).rejects.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
