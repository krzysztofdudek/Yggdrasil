import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// The check command must route EVERY terminal exit through exitAfterFlush — which
// drains stdout and force-exits via an unref'd 2s backstop — so a lingering libuv
// handle left by the LLM provider (an undici keep-alive socket, an AbortSignal
// timer) can never hang a CLEAN `--approve`. Before the fix the success path fell
// through to a bare `return`, relying on the event loop draining; with a dangling
// handle that never happens and the process hangs after the report is printed.
//
// These tests pin the control flow in-process: a clean --approve calls
// exitAfterFlush(0); an --approve with errors calls exitAfterFlush(1). The real
// exitAfterFlush is covered by exit-after-flush.test.ts; here it is mocked to
// process.exit so the requested code surfaces.

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

import { registerCheckCommand } from '../../../src/cli/check.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { runFill } from '../../../src/core/fill.js';
import { runCheck } from '../../../src/core/check.js';
import { exitAfterFlush } from '../../../src/cli/exit-after-flush.js';
import type { CheckIssue, CheckResult } from '../../../src/core/check.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockRunFill = vi.mocked(runFill);
const mockRunCheck = vi.mocked(runCheck);
const mockExitAfterFlush = vi.mocked(exitAfterFlush);

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
  };
}

const ERROR_ISSUE: CheckIssue = {
  severity: 'error',
  code: 'unverified',
  rule: 'unverified',
  messageData: { what: 'x', why: 'y', next: 'z' },
};

describe('check --approve always force-exits via exitAfterFlush', () => {
  let exitCode: number | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitCode = undefined;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    mockLoadGraph.mockReset();
    mockRunFill.mockReset();
    mockExitAfterFlush.mockClear();
    mockExitAfterFlush.mockImplementation(((code: number) => process.exit(code)) as never);
    // dirname is a non-existent path so collectGitFiles' `git ls-files` fails fast → null.
    mockLoadGraph.mockResolvedValue({ rootPath: '/nonexistent-yg-test/.yggdrasil', config: {} } as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  async function runApprove(issues: CheckIssue[]): Promise<void> {
    mockRunFill.mockResolvedValue({
      checkResult: makeCheckResult(issues),
      reviewerCallsMade: 0,
      infraFailures: 0,
      runtimeErrors: 0,
      companionRuntimeErrors: 0,
      malformedSuppressErrors: 0,
    });
    const program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'check', '--approve']);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  it('a CLEAN --approve (no errors) force-exits via exitAfterFlush(0) — never relies on event-loop drain', async () => {
    await runApprove([]);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0);
    expect(exitCode).toBe(0);
  });

  it('an --approve with errors force-exits via exitAfterFlush(1)', async () => {
    await runApprove([ERROR_ISSUE]);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(1);
    expect(exitCode).toBe(1);
  });
});

// ── Fix 5: --dry-run budget reaches stdout EVEN under --quiet ────────────────
//
// The dry-run budget preview is the command's primary deliverable. --quiet must
// only silence the non-dry-run progress stream (stderr); it must NEVER drop the
// dry-run budget. The write sink passed to runFill routes the budget — so with
// --approve --dry-run --quiet, calling that sink must land on STDOUT, not a
// swallowing no-op.
describe('check --approve --dry-run --quiet: budget still reaches stdout', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    mockLoadGraph.mockReset();
    mockRunFill.mockReset();
    mockExitAfterFlush.mockClear();
    mockExitAfterFlush.mockImplementation(((code: number) => process.exit(code)) as never);
    mockLoadGraph.mockResolvedValue({ rootPath: '/nonexistent-yg-test/.yggdrasil', config: {} } as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  async function runFlags(extra: string[]): Promise<void> {
    // runFill is mocked: it invokes the supplied write sink with a sentinel
    // budget line (as the real dry-run path does), then resolves a clean result.
    mockRunFill.mockImplementation((async (_graph: unknown, opts: { write: (s: string) => void }) => {
      opts.write('BUDGET-LINE: 3 reviewer calls\n');
      return {
        checkResult: makeCheckResult([]),
        reviewerCallsMade: 0,
        infraFailures: 0,
        runtimeErrors: 0,
        companionRuntimeErrors: 0,
        malformedSuppressErrors: 0,
      };
    }) as never);
    const program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'check', ...extra]);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  it('--approve --dry-run --quiet emits the budget on STDOUT (not swallowed)', async () => {
    await runFlags(['--approve', '--dry-run', '--quiet']);
    const stdoutCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const stderrCalls = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    // The budget MUST reach stdout even with --quiet.
    expect(stdoutCalls).toContain('BUDGET-LINE: 3 reviewer calls');
    // And it must NOT have been routed to stderr.
    expect(stderrCalls).not.toContain('BUDGET-LINE');
  });

  it('--approve --dry-run (no --quiet) emits the budget on STDOUT', async () => {
    await runFlags(['--approve', '--dry-run']);
    const stdoutCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stdoutCalls).toContain('BUDGET-LINE: 3 reviewer calls');
  });
});

// ── Fix 7: --summary / --top cannot combine with --only-deterministic ────────
//
// --summary and --top are READ-ONLY triage views; --only-deterministic is a
// FILL flag. The combination is contradictory — the triage-view override would
// silently drop the requested deterministic fill, leaving the user believing
// they filled when they did not. The CLI must reject the combination outright.
describe('check: --summary/--top + --only-deterministic is rejected', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = undefined;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    mockLoadGraph.mockReset();
    mockRunFill.mockReset();
    mockExitAfterFlush.mockClear();
    mockExitAfterFlush.mockImplementation(((code: number) => process.exit(code)) as never);
    mockLoadGraph.mockResolvedValue({ rootPath: '/nonexistent-yg-test/.yggdrasil', config: {} } as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  async function runFlags(extra: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'check', ...extra]);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  it('--summary --only-deterministic → guided error on stderr, exit 1, no fill', async () => {
    await runFlags(['--summary', '--only-deterministic']);
    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(err).toContain('--summary');
    expect(err).toContain('--only-deterministic');
    expect(exitCode).toBe(1);
    // The fill must NOT have run — the rejection happens before any work.
    expect(mockRunFill).not.toHaveBeenCalled();
  });

  it('--top --only-deterministic → guided error on stderr, exit 1, no fill', async () => {
    await runFlags(['--top', '--only-deterministic']);
    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(err).toContain('--top');
    expect(err).toContain('--only-deterministic');
    expect(exitCode).toBe(1);
    expect(mockRunFill).not.toHaveBeenCalled();
  });

  it('--top 5 --only-deterministic (numeric --top) → guided error, exit 1', async () => {
    await runFlags(['--top', '5', '--only-deterministic']);
    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(err).toContain('--top');
    expect(err).toContain('--only-deterministic');
    expect(exitCode).toBe(1);
    expect(mockRunFill).not.toHaveBeenCalled();
  });
});

// ── Fix 6(a): --aspect <unknown-id> errors instead of silent zero-count FAIL ──
//
// An unknown / mistyped --aspect id must produce a clear error naming the
// unrecognized id, NOT a misleading "0 of N errors" FAIL that looks like the
// rule simply has no issues this run. Validation uses the real aspect ids from
// the loaded graph.
describe('check --aspect <unknown-id>: clear error, not a silent zero-count', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = undefined;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    mockLoadGraph.mockReset();
    mockRunCheck.mockReset();
    mockExitAfterFlush.mockClear();
    mockExitAfterFlush.mockImplementation(((code: number) => process.exit(code)) as never);
    // Graph with two real aspects: 'audit-logging' and 'input-validation'.
    mockLoadGraph.mockResolvedValue({
      rootPath: '/nonexistent-yg-test/.yggdrasil',
      config: {},
      aspects: [{ id: 'audit-logging' }, { id: 'input-validation' }],
    } as never);
    mockRunCheck.mockResolvedValue(makeCheckResult([ERROR_ISSUE]));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  async function runFlags(extra: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'check', ...extra]);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  it('--aspect typo → error names the unknown id, exit 1, no zero-count FAIL render', async () => {
    await runFlags(['--aspect', 'audit-loggin']); // typo
    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    // The error must name the unknown id.
    expect(err).toContain('audit-loggin');
    expect(err.toLowerCase()).toContain('unknown aspect');
    expect(exitCode).toBe(1);
    // It must NOT render the misleading "0 of N errors" drill-in FAIL.
    expect(out).not.toContain('0 of');
    // runCheck must NOT have run (rejection is pre-flight).
    expect(mockRunCheck).not.toHaveBeenCalled();
  });

  it('--aspect with a REAL id is accepted (renders the drill-in, no unknown-id error)', async () => {
    await runFlags(['--aspect', 'audit-logging']);
    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(err).not.toContain('unknown aspect');
    // runCheck DID run for a valid id.
    expect(mockRunCheck).toHaveBeenCalled();
  });
});
