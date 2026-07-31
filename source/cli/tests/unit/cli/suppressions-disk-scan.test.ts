import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// yg suppressions must scan files using walkRepoFiles (disk + gitignore),
// not `git ls-files` (git index). This pins the plumbing: walkRepoFiles
// result is the file list scanned for yg-suppress markers.

vi.mock('../../../src/cli/preamble.js', () => ({
  loadGraphOrAbort: vi.fn(),
  abortOnUnexpectedError: vi.fn(),
}));
vi.mock('../../../src/utils/debug-log.js', () => ({
  initDebugLog: vi.fn(),
  debugWrite: vi.fn(),
}));
vi.mock('../../../src/io/debug-log-writer.js', () => ({ appendToDebugLog: vi.fn() }));
// Only walkRepoFiles is mocked (that is the plumbing this file pins); every other
// export — including findNestedProjectRoots, which the suppression scan's file
// universe now also relies on (via expandMappingPathsWithinOwnGraph, on the
// mapped-file side of its union) — passes through to the real module. Replacing
// the whole module would silently drop those real functions to `undefined` for
// every importer, not just this file's own.
vi.mock('../../../src/io/repo-scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/io/repo-scanner.js')>();
  return { ...actual, walkRepoFiles: vi.fn() };
});

import { registerSuppressionsCommand } from '../../../src/cli/suppressions.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import { computeSuppressionScanUniverse } from '../../../src/portal/api/suppress-eligibility.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockWalkRepoFiles = vi.mocked(walkRepoFiles);

describe('yg suppressions uses disk scan (walkRepoFiles), not git ls-files', () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-supp-disk-'));
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    mockLoadGraph.mockReset();
    mockWalkRepoFiles.mockReset();
    mockLoadGraph.mockResolvedValue({
      rootPath: path.join(tmpDir, '.yggdrasil'),
      aspects: [],
      config: {},
      // `yg suppressions` now derives mapped-source eligibility from the graph so a
      // honored marker in a mapped prose file is inventoried (parity with honoring).
      nodes: new Map(),
    } as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runSuppressions(): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerSuppressionsCommand(program);
    await program.parseAsync(['node', 'yg', 'suppressions']);
  }

  it('finds suppress markers in files returned by walkRepoFiles', async () => {
    // Write a real file with a suppress marker to the temp dir
    const srcDir = path.join(tmpDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, 'handler.ts'),
      '// yg-suppress(auth-guard) legacy endpoint, tracked in debt registry\ndoWork();\n',
    );
    // Mock walkRepoFiles to return this file (simulating disk scan)
    mockWalkRepoFiles.mockResolvedValue(['src/handler.ts']);

    await runSuppressions();

    const output = stdoutChunks.join('');
    expect(output).toContain('auth-guard');
    expect(output).not.toContain('No active suppression markers found.');
  });

  it('finds no markers when walkRepoFiles returns an empty list', async () => {
    mockWalkRepoFiles.mockResolvedValue([]);

    await runSuppressions();

    const output = stdoutChunks.join('');
    expect(output).toContain('No active suppression markers found.');
  });

  it('walkRepoFiles is called with the project root derived from rootPath', async () => {
    mockWalkRepoFiles.mockResolvedValue([]);

    await runSuppressions();

    expect(mockWalkRepoFiles).toHaveBeenCalledOnce();
    const [calledRoot] = mockWalkRepoFiles.mock.calls[0] as [string];
    expect(calledRoot).toBe(tmpDir);
  });
});

// =============================================================================
// computeSuppressionScanUniverse — the audit-side candidate list `yg
// suppressions` and the portal inventory scan. It must exclude a nested
// project's files exactly like the runner that honors markers on them
// (structure/hook-loader.ts), or a waiver honored by the runner would be
// invisible to this inventory — the exact defect the shared, filesystem-derived
// boundary exists to make impossible. No module mocking here: real fixture,
// real function, real disk.
// =============================================================================
describe('computeSuppressionScanUniverse excludes a nested project from the audit universe', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-supp-universe-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a mapped directory containing a nested `.yggdrasil/` graph contributes only its own files to the universe', async () => {
    const servicesDir = path.join(tmpDir, 'services');
    mkdirSync(servicesDir, { recursive: true });
    writeFileSync(path.join(servicesDir, 'alpha.py'), '# yg-suppress(det-perfile) known debt\ndoWork()\n');
    const vendorYgg = path.join(servicesDir, 'vendorlib', '.yggdrasil');
    mkdirSync(vendorYgg, { recursive: true });
    writeFileSync(path.join(vendorYgg, 'yg-config.yaml'), 'version: "5.2.0"\n');
    writeFileSync(
      path.join(servicesDir, 'vendorlib', 'other.py'),
      '# yg-suppress(det-perfile) a foreign waiver this graph must never inventory\ndoWork()\n',
    );

    // walkedFiles simulates walkRepoFiles' own output (already excludes the
    // nested subtree) — the universe's SECOND member, the mapped-file
    // expansion, is the one under test here.
    const walkedFiles = ['services/alpha.py'];
    const universe = await computeSuppressionScanUniverse(tmpDir, walkedFiles, ['services']);

    expect(universe.sort()).toEqual(['services/alpha.py']);
    expect(universe).not.toContain('services/vendorlib/other.py');
    expect(universe).not.toContain('services/vendorlib/.yggdrasil/yg-config.yaml');
  });

  it('two nodes with DIFFERENT mapping entries, expanded TOGETHER (the real audit shape), draw the same boundary as either expanded alone', async () => {
    const servicesDir = path.join(tmpDir, 'services');
    mkdirSync(servicesDir, { recursive: true });
    writeFileSync(path.join(servicesDir, 'alpha.py'), 'doWork()\n');
    writeFileSync(path.join(servicesDir, 'config.yaml'), 'k: v\n');
    const vendorYgg = path.join(servicesDir, 'vendorlib', '.yggdrasil');
    mkdirSync(vendorYgg, { recursive: true });
    writeFileSync(path.join(vendorYgg, 'yg-config.yaml'), 'version: "5.2.0"\n');
    writeFileSync(path.join(servicesDir, 'vendorlib', 'other.py'), 'SECRET = 1\n');

    // The audit path expands every node's mapping entries TOGETHER in one call
    // (portal/engine-api.ts's collectMappingEntries → computeSuppressionScanUniverse),
    // unlike enforcement, which expands one node's mapping at a time. Both must
    // land on the identical boundary.
    const universe = await computeSuppressionScanUniverse(tmpDir, [], ['services/**/*.py', 'services/**/*.yaml']);

    expect(universe.sort()).toEqual(['services/alpha.py', 'services/config.yaml']);
    expect(universe.some((f) => f.startsWith('services/vendorlib/'))).toBe(false);
  });
});
