// Registration contract for `yg drill`. No mocking — a real Commander program is
// introspected. The command's end-to-end behaviour (deterministic path, LLM path
// with the mock reviewer, the honesty frame, exit codes) is exercised over the
// public CLI surface in tests/e2e/cli-drill.test.ts.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerDrillCommand } from '../../../src/cli/drill.js';

function drillCommand(): Command {
  const program = new Command();
  registerDrillCommand(program);
  const cmd = program.commands.find((c) => c.name() === 'drill');
  if (!cmd) throw new Error('drill command not registered');
  return cmd;
}

describe('registerDrillCommand', () => {
  it('registers a `drill` subcommand with a description', () => {
    const cmd = drillCommand();
    expect(cmd.name()).toBe('drill');
    expect(cmd.description().length).toBeGreaterThan(0);
  });

  it('requires --aspect and offers --dir / --case / --corpus', () => {
    const cmd = drillCommand();
    const byLong = Object.fromEntries(cmd.options.map((o) => [o.long, o]));
    expect(byLong['--aspect']).toBeDefined();
    expect(byLong['--aspect'].required).toBe(true);
    expect(byLong['--dir']).toBeDefined();
    expect(byLong['--case']).toBeDefined();
    expect(byLong['--corpus']).toBeDefined();
  });
});
