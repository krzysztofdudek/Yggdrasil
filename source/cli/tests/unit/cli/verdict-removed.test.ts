import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerRemovedVerdictCommand } from '../../../src/cli/verdict-removed.js';

class ExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function runVerdict(args: string[]): { stderr: string; exitCode: number | undefined } {
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  const program = new Command();
  program.exitOverride();
  registerRemovedVerdictCommand(program);
  let exitCode: number | undefined;
  try {
    program.parse(['node', 'yg', 'verdict', ...args]);
  } catch (e) {
    if (e instanceof ExitCalled) exitCode = e.code;
    else throw e;
  }
  return { stderr, exitCode };
}

afterEach(() => vi.restoreAllMocks());

describe('yg verdict (removed)', () => {
  it('fails with exit 1 and points at yg check --approve', () => {
    const { stderr, exitCode } = runVerdict(['record']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('yg verdict (package, record, read) was removed in 6.1.0.');
    expect(stderr).toContain('yg check --approve');
  });

  it('accepts whatever the old subcommands took, so the pointer is always reached', () => {
    const { stderr, exitCode } = runVerdict(['record', '--aspect', 'x', '--judge', 'someone', 'extra']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('removed in 6.1.0');
  });

  it('is hidden from the help listing', () => {
    const program = new Command();
    registerRemovedVerdictCommand(program);
    expect(program.helpInformation()).not.toContain('verdict');
  });
});
