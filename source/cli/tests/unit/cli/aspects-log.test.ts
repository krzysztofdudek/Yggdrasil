// Registration contract for a rule's own history, which `yg log` writes and
// reads with `--aspect` since `yg aspects log` was removed. No mocking — real
// Commander programs are introspected. The end-to-end behaviour (entries
// written and read back, a standing recorded, every refusal, a standing changed
// by hand being noticed once) is exercised over the public CLI surface in
// tests/e2e/cli-aspects-log.test.ts.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerAspectsCommand } from '../../../src/cli/aspects.js';
import { registerLogCommand } from '../../../src/cli/log.js';

function logSub(name: string): Command {
  const program = new Command();
  registerLogCommand(program);
  const found = program.commands.find((c) => c.name() === 'log')?.commands.find((c) => c.name() === name);
  if (!found) throw new Error(`log ${name} not registered`);
  return found;
}

describe("a rule's history is one of the logs yg log names", () => {
  it('yg aspects has no log subcommand any more', () => {
    const program = new Command();
    registerAspectsCommand(program);
    const aspects = program.commands.find((c) => c.name() === 'aspects');
    expect(aspects).toBeDefined();
    expect(aspects!.commands.map((c) => c.name())).not.toContain('log');
  });

  it('yg log add takes the rule and the standing flags, none of them demanded up front', () => {
    const add = Object.fromEntries(logSub('add').options.map((o) => [o.long, o]));
    // Exactly one of --node, --type, --aspect is checked at run time, so none is mandatory.
    expect(add['--aspect'].mandatory).toBe(false);
    expect(add['--reason'].mandatory).toBe(false);
    expect(add['--reason-file'].mandatory).toBe(false);
    // A standing is recorded only when there is one to record, and what
    // justified it is checked with it rather than declared mandatory here.
    expect(add['--status'].mandatory).toBe(false);
    expect(add['--evidence'].mandatory).toBe(false);
    expect(add['--by'].mandatory).toBe(false);
  });

  it('yg log read takes the rule, --top / --all and the document form; --limit is gone', () => {
    const read = Object.fromEntries(logSub('read').options.map((o) => [o.long, o]));
    expect(read['--aspect'].required).toBe(true);
    expect(read['--top'].required).toBe(true);
    expect(read['--all'].required).toBe(false);
    expect(read['--json'].required).toBe(false);
    expect(read['--limit']).toBeUndefined();
  });
});
