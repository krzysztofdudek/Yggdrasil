// Registration contract for `yg aspects log`. No mocking — a real Commander
// program is introspected. The commands' end-to-end behaviour (entries written
// and read back, a standing recorded, every refusal, a standing changed by hand
// being noticed once) is exercised over the public CLI surface in
// tests/e2e/cli-aspects-log.test.ts.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerAspectsCommand } from '../../../src/cli/aspects.js';

function logCommand(): Command {
  const program = new Command();
  registerAspectsCommand(program);
  const aspects = program.commands.find((c) => c.name() === 'aspects');
  if (!aspects) throw new Error('aspects command not registered');
  const log = aspects.commands.find((c) => c.name() === 'log');
  if (!log) throw new Error('aspects log subcommand not registered');
  return log;
}

function sub(name: string): Command {
  const found = logCommand().commands.find((c) => c.name() === name);
  if (!found) throw new Error(`aspects log ${name} not registered`);
  return found;
}

describe('registerAspectsLogCommand', () => {
  it("registers `log` under `aspects`, with both halves of a rule's history", () => {
    const log = logCommand();
    expect(log.description().length).toBeGreaterThan(0);
    expect(log.commands.map((c) => c.name()).sort()).toEqual(['add', 'read']);
  });

  it('demands the rule on both, and leaves the text and the standing optional on add', () => {
    const add = Object.fromEntries(sub('add').options.map((o) => [o.long, o]));

    // Without the rule there is no history to write to.
    expect(add['--aspect'].mandatory).toBe(true);

    // The text has two sources, so neither can be demanded on its own; the
    // command refuses at run time when both or neither is given.
    expect(add['--reason'].mandatory).toBe(false);
    expect(add['--reason-file'].mandatory).toBe(false);

    // A standing is recorded only when there is one to record, and what
    // justified it is checked with it rather than declared mandatory here.
    expect(add['--status'].mandatory).toBe(false);
    expect(add['--evidence'].mandatory).toBe(false);
    expect(add['--by'].mandatory).toBe(false);
  });

  it('offers the reader a limit and a document form', () => {
    const read = Object.fromEntries(sub('read').options.map((o) => [o.long, o]));
    expect(read['--aspect'].mandatory).toBe(true);
    expect(read['--limit'].required).toBe(true);
    expect(read['--json'].required).toBe(false);
  });
});
