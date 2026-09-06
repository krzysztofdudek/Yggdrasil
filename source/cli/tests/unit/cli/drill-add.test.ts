// Registration contract for `yg drill add`. No mocking — a real Commander
// program is introspected. The command's end-to-end behaviour (reading a file at
// a commit, the case that stays when the rule misses it, every refusal) is
// exercised over the public CLI surface in tests/e2e/cli-drill-add.test.ts.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerDrillCommand } from '../../../src/cli/drill.js';

function addCommand(): Command {
  const program = new Command();
  registerDrillCommand(program);
  const drill = program.commands.find((c) => c.name() === 'drill');
  if (!drill) throw new Error('drill command not registered');
  const add = drill.commands.find((c) => c.name() === 'add');
  if (!add) throw new Error('drill add subcommand not registered');
  return add;
}

describe('registerDrillAddCommand', () => {
  it('registers `add` under `drill`, with a description', () => {
    const cmd = addCommand();
    expect(cmd.name()).toBe('add');
    expect(cmd.description().length).toBeGreaterThan(0);
  });

  it('demands the rule and the violating case, and offers the fix and the reason', () => {
    const byLong = Object.fromEntries(addCommand().options.map((o) => [o.long, o]));

    // Without these two there is no rule to file under and no code to file.
    expect(byLong['--aspect'].mandatory).toBe(true);
    expect(byLong['--violates'].mandatory).toBe(true);

    // The counterpart case and the reason are both offered, never demanded: a
    // case can stand alone, and a reason nobody gave is never invented.
    expect(byLong['--satisfies'].mandatory).toBe(false);
    expect(byLong['--why'].mandatory).toBe(false);
    expect(byLong['--why'].required).toBe(true);
  });

  it('leaves the corpus-running form beside it, naming the rule without demanding it up front', () => {
    const program = new Command();
    registerDrillCommand(program);
    const drill = program.commands.find((c) => c.name() === 'drill');
    const byLong = Object.fromEntries((drill?.options ?? []).map((o) => [o.long, o]));

    // The rule is checked inside the command rather than declared mandatory: a
    // mandatory option on a command that carries subcommands is enforced before
    // the subcommand is reached, which would refuse `drill add --aspect <id>`
    // for lacking the very flag it was given.
    expect(byLong['--aspect']).toBeDefined();
    expect(byLong['--aspect'].mandatory).toBe(false);
    expect((drill?.commands ?? []).map((c) => c.name())).toEqual(['add']);
  });
});
