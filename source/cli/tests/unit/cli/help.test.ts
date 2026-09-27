/**
 * `yg --help` groups the commands by task with one line each; a command's own
 * help opens with that line and lists options in one style with examples; and
 * an error the argument parser raises is reported in the one error grammar —
 * `error[usage]: …` with the command's help as the next step — never as
 * commander's own `error: …` line.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerHelpCommand } from '../../../src/cli/help.js';
import { setJsonOutput } from '../../../src/cli/output.js';

function program(): Command {
  const p = new Command().name('yg').exitOverride();
  p.command('check').description('Unified graph gate — verification, coverage, completeness').option('--top [n]', 'print only the N highest-priority blocks.').option('--limit <n>', 'how many', '12').action(() => {});
  p.command('tree').description('List graph nodes').action(() => {});
  p.command('init').description('Initialize Yggdrasil graph').action(() => {});
  registerHelpCommand(p);
  return p;
}

afterEach(() => {
  vi.restoreAllMocks();
  setJsonOutput(undefined);
});

describe('yg --help', () => {
  it('groups the commands by task, one line each, with examples and where options live', () => {
    const text = program().helpInformation();
    expect(text).toMatch(/^yg — /);
    expect(text).toContain('\nDaily\n  check  Run the gate: rules, coverage, relations\n');
    expect(text).toContain('\nExplore\n  tree   All nodes, one line each\n');
    expect(text).toContain('\nSetup\n  init\n');
    expect(text).toContain('Examples\n  yg check ');
    expect(text).toContain('Run yg <command> --help for its options.');
    // No flat, wrapped list of every command's long description.
    expect(text).not.toContain('Commands:');
    expect(text).not.toContain('Unified graph gate');
  });

  it("a command's help opens with its one line, one option style, examples, and the long text as About", () => {
    const check = program().commands.find((c) => c.name() === 'check')!;
    // The examples and the About text are printed after the help proper, so
    // read what the command actually writes, not only helpInformation().
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    check.outputHelp();
    const text = out.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('Run the gate: rules, coverage, relations');
    expect(text).toContain('Print only the N highest-priority blocks\n');
    expect(text).toContain('How many (default: 12)');
    expect(text).not.toContain('"12"');
    expect(text).toContain('\nExamples\n  yg check ');
    expect(text).toContain('\nAbout\n  Unified graph gate — verification, coverage, completeness');
  });

  it('marks an option the command cannot run without as required, whether the parser or the command enforces it', () => {
    const p = new Command().name('yg').exitOverride();
    const incident = p.command('incident');
    incident.command('add').requiredOption('--reason <text>', 'what escaped').option('--aspect <id>', 'the rule it escaped').action(() => {});
    // drill checks --aspect itself: a required option on a parent would refuse `drill add --aspect x`.
    p.command('drill').option('--aspect <id>', 'aspect id whose case corpus to drill').action(() => {});
    registerHelpCommand(p);
    const add = incident.commands.find((c) => c.name() === 'add')!;
    const drill = p.commands.find((c) => c.name() === 'drill')!;
    expect(add.helpInformation()).toContain('What escaped (required)');
    expect(add.helpInformation()).toContain('The rule it escaped\n');
    expect(add.helpInformation()).not.toContain('The rule it escaped (required)');
    expect(drill.helpInformation()).toContain('Aspect id whose case corpus to drill (required)');
  });
});

describe('usage errors from the argument parser', () => {
  it('read as error[usage] with the command help as the next step, on stderr only', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setJsonOutput(false);
    expect(() => program().parse(['check', '--qqqqqq'], { from: 'user' })).toThrow();
    const text = err.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toBe("error[usage]: unknown option '--qqqqqq'\nnext: yg check --help\n");
    expect(out).not.toHaveBeenCalled();
  });

  it('write the yg-error/1 document on stdout for a JSON invocation', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setJsonOutput(true);
    expect(() => program().parse(['check', '--qqqqqq'], { from: 'user' })).toThrow();
    const doc = JSON.parse(out.mock.calls.map((c) => String(c[0])).join(''));
    expect(doc).toMatchObject({ schema: 'yg-error/1', code: 'usage', what: "unknown option '--qqqqqq'", next: { text: 'yg check --help' } });
  });

  it('name the root help for an unknown command', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    setJsonOutput(false);
    expect(() => program().parse(['nope'], { from: 'user' })).toThrow();
    const text = err.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toMatch(/^error\[usage\]: unknown command 'nope'/);
    expect(text).toContain('next: yg --help');
  });
});
