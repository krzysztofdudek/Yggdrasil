import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// check.ts must use walkRepoFiles (disk scan + gitignore) instead of
// `git ls-files` (git index). A file deleted from disk with `rm` but not
// `git rm` must NOT appear in the coverage scan.
//
// The test pins the plumbing: walkRepoFiles result is the value passed to
// runFill as gitTrackedFiles. Before the fix, git ls-files is used and
// fails on a non-existent path → null is passed. After the fix, walkRepoFiles
// is called and its result ([] for a non-existent path, or our mock value)
// is passed.

vi.mock('../../../src/cli/preamble.js', () => ({
  loadGraphOrAbort: vi.fn(),
  abortOnUnexpectedError: vi.fn(),
}));
vi.mock('../../../src/utils/debug-log.js', () => ({
  initDebugLog: vi.fn(),
  debugWrite: vi.fn(),
}));
vi.mock('../../../src/io/debug-log-writer.js', () => ({ appendToDebugLog: vi.fn() }));
vi.mock('../../../src/core/check.js', () => ({ runCheck: vi.fn() }));
vi.mock('../../../src/core/fill.js', () => ({
  runFill: vi.fn(),
  FillGatingError: class FillGatingError extends Error {},
}));
vi.mock('../../../src/cli/exit-after-flush.js', () => ({
  exitAfterFlush: vi.fn((code: number) => process.exit(code)),
}));
vi.mock('../../../src/io/repo-scanner.js', () => ({
  walkRepoFiles: vi.fn(),
  listGitTrackedFiles: vi.fn(),
}));

import { registerCheckCommand } from '../../../src/cli/check.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { runFill } from '../../../src/core/fill.js';
import { exitAfterFlush } from '../../../src/cli/exit-after-flush.js';
import { walkRepoFiles, listGitTrackedFiles } from '../../../src/io/repo-scanner.js';
import type { CheckIssue, CheckResult } from '../../../src/core/check.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockRunFill = vi.mocked(runFill);
const mockExitAfterFlush = vi.mocked(exitAfterFlush);
const mockWalkRepoFiles = vi.mocked(walkRepoFiles);
const mockListGitTrackedFiles = vi.mocked(listGitTrackedFiles);

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function makeCheckResult(issues: CheckIssue[]): CheckResult {
  return {
    projectName: 'p',
    nodeCount: 1,
    nodeTypeCounts: new Map(),
    aspectCount: 0,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues,
    suggestedNext: null,
    advisoryWarnings: 0,
    draftSkipped: 0,
    verifiedDet: 0,
    verifiedLlm: 0,
  };
}

describe('check --approve uses disk scan (walkRepoFiles), not git ls-files', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    mockLoadGraph.mockReset();
    mockRunFill.mockReset();
    mockExitAfterFlush.mockReset();
    mockWalkRepoFiles.mockReset();
    mockListGitTrackedFiles.mockReset();
    mockExitAfterFlush.mockImplementation(((code: number) => process.exit(code)) as never);
    mockLoadGraph.mockResolvedValue({
      rootPath: '/fake-project/.yggdrasil',
      config: {},
    } as never);
    mockWalkRepoFiles.mockResolvedValue(['src/kept.ts', 'src/other.ts']);
    mockListGitTrackedFiles.mockReturnValue(null);
    mockRunFill.mockResolvedValue({
      checkResult: makeCheckResult([]),
      reviewerCallsMade: 0,
      infraFailures: 0,
      runtimeErrors: 0,
      companionRuntimeErrors: 0,
      malformedSuppressErrors: 0,
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  async function runApprove(): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'check', '--approve']);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  it('passes walkRepoFiles result to runFill as gitTrackedFiles (not null from failed git ls-files)', async () => {
    await runApprove();

    expect(mockWalkRepoFiles).toHaveBeenCalledOnce();
    const [, fillOpts] = mockRunFill.mock.calls[0] as Parameters<typeof runFill>;
    expect((fillOpts as { gitTrackedFiles: unknown }).gitTrackedFiles).toEqual([
      'src/kept.ts',
      'src/other.ts',
    ]);
  });

  it('walkRepoFiles is called with the project root (not .yggdrasil path)', async () => {
    await runApprove();

    const [calledRoot] = mockWalkRepoFiles.mock.calls[0] as [string];
    expect(calledRoot).toBe('/fake-project');
  });
});
