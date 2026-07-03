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
vi.mock('../../../src/io/repo-scanner.js', () => ({
  walkRepoFiles: vi.fn(),
}));

import { registerSuppressionsCommand } from '../../../src/cli/suppressions.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

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
