/**
 * Unit tests for the CLI output layer (src/cli/output.ts, src/cli/output-diagnostic.ts):
 * the count/list/block/verdict/next primitives, the code registry, the
 * diagnostic conversions, and the command-error path (text on stderr, the
 * yg-error/1 document on stdout only when the invocation answers in JSON).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  count, plural, list, overflowLine, block, verdict, next, fixPointer,
  fail, failAndExit, notice, setJsonOutput, isJsonOutput, errorDocument, ERROR_JSON_SCHEMA, MEMBER_CAP,
} from '../../../src/cli/output.js';
import { codeInfo, tierRank, fromIssueMessage, toIssueMessage, GRAPH_INVALID_CODES } from '../../../src/cli/output-diagnostic.js';

afterEach(() => {
  vi.restoreAllMocks();
  setJsonOutput(false);
});

describe('count / plural', () => {
  it('agrees the noun with the number, zero included', () => {
    expect(count(1, 'pair')).toBe('1 pair');
    expect(count(2, 'pair')).toBe('2 pairs');
    expect(count(0, 'pair')).toBe('0 pairs');
    expect(plural(1, 'entry', 'entries')).toBe('entry');
    expect(count(3, 'entry', 'entries')).toBe('3 entries');
  });
});

describe('list', () => {
  it('shows everything under the cap and says nothing more', () => {
    expect(list(['a', 'b'], { cap: 3, indent: '  ' })).toEqual(['  a', '  b']);
  });

  it('caps, and the overflow line names how many are hidden and the drill', () => {
    const items = Array.from({ length: MEMBER_CAP + 3 }, (_, i) => `m${i}`);
    const out = list(items, { cap: MEMBER_CAP, drill: 'yg check --aspect no-todo', indent: '  ' });
    expect(out).toHaveLength(MEMBER_CAP + 1);
    expect(out[MEMBER_CAP]).toBe('  … +3 more  (yg check --aspect no-todo)');
  });

  it('an overflow with no drill still counts what it hid', () => {
    expect(overflowLine(5, undefined)).toBe('… +5 more');
  });

  it('an overflow wording can be supplied by the caller', () => {
    const out = list(['a', 'b', 'c'], { cap: 1, overflow: (k) => `... and ${k} more` });
    expect(out).toEqual(['a', '... and 2 more']);
  });
});

describe('block / verdict / next / fixPointer', () => {
  it('renders an error[code] heading, a labelled why and a next line, keeping multi-line what whole', () => {
    expect(block({ what: 'a\n  b', why: 'w', next: 'n' })).toBe('error[command-error]: a\n  b\n  why:  w\nnext: n');
    const d = fromIssueMessage({ what: 'a\n  b', why: 'w', next: 'n' }, { code: 'x' });
    expect(block(d)).toBe('error[x]: a\n  b\n  why:  w\nnext: n');
  });

  it('states a verdict as `<command>: <STATUS>  <tail>`', () => {
    expect(verdict('yg check', 'FAIL', '3 nodes', false)).toBe('yg check: FAIL  3 nodes');
    expect(verdict('yg check --approve', 'ABORTED', '', false)).toBe('yg check --approve: ABORTED');
  });

  it('prints the next step with its suffix', () => {
    expect(next('yg check --approve', '  (fills 2)')).toBe('next: yg check --approve  (fills 2)');
  });

  it('keeps a heading-introduced list whole and trims a plain fix to its first line', () => {
    expect(fixPointer('Three exits:\n  1. a\n  2. b')).toBe('Three exits:\n  1. a\n  2. b');
    expect(fixPointer('yg check --approve\nthen read the report')).toBe('yg check --approve');
  });
});

describe('code registry', () => {
  it('labels the refusal codes as the report does, and defaults every other code to itself', () => {
    expect(codeInfo('aspect-violation-enforced').label).toBe('refused');
    expect(codeInfo('aspect-violation-advisory').label).toBe('refused');
    expect(codeInfo('unmapped-files').label).toBe('unmapped');
    expect(codeInfo('relation-broken')).toEqual({ label: 'relation-broken', tier: 'T1', noun: 'issue' });
  });

  it('puts every graph-invalid code in tier T0, ahead of everything else', () => {
    for (const code of GRAPH_INVALID_CODES) expect(codeInfo(code).tier).toBe('T0');
    expect(tierRank(codeInfo('config-invalid').tier)).toBeLessThan(tierRank(codeInfo('unverified').tier));
    expect(codeInfo('log-entry-missing').tier).toBe('T2');
  });

  it('cannot land on an inherited Object.prototype key', () => {
    expect(codeInfo('constructor').label).toBe('constructor');
    expect(codeInfo('__proto__').tier).toBe('T1');
  });
});

describe('diagnostic conversions', () => {
  it('records a fix as a command only when its first line is a whole runnable command', () => {
    expect(fromIssueMessage({ what: 'w', why: 'y', next: 'yg check --approve' }, { code: 'c' }).fix?.command).toBe('yg check --approve');
    expect(fromIssueMessage({ what: 'w', why: 'y', next: "yg log add --node x --reason '<why>'" }, { code: 'c' }).fix?.command).toBeUndefined();
    expect(fromIssueMessage({ what: 'w', why: 'y', next: 'Run: yg tree.' }, { code: 'c' }).fix?.command).toBeUndefined();
    expect(fromIssueMessage({ what: 'w', why: 'y', next: 'yg tree, then retry.' }, { code: 'c' }).fix?.command).toBeUndefined();
  });

  it('round-trips a what/why/next triple', () => {
    const msg = { what: 'one\ntwo', why: 'because', next: 'yg tree' };
    expect(toIssueMessage(fromIssueMessage(msg, { code: 'c' }))).toEqual(msg);
  });
});

describe('fail / failAndExit / notice', () => {
  it('writes `error[code]: what / why: / next:` to stderr and nothing to stdout by default', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fail({ what: 'Node nope not found.', why: 'It must exist.', next: 'yg tree' });
    const text = err.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('error[node-not-found]: Node nope not found.\n  why:  It must exist.\nnext: yg tree');
    expect(text.endsWith('\n')).toBe(true);
    expect(out).not.toHaveBeenCalled();
  });

  it('also writes the yg-error/1 document to stdout when the invocation answers in JSON', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setJsonOutput(true);
    expect(isJsonOutput()).toBe(true);
    fail({ what: 'Node nope not found.', why: 'It must exist.', next: 'yg tree' }, 'node-not-found');
    const doc = JSON.parse(out.mock.calls.map((c) => String(c[0])).join(''));
    expect(doc).toEqual({
      schema: ERROR_JSON_SCHEMA,
      code: 'node-not-found',
      what: 'Node nope not found.',
      why: 'It must exist.',
      next: { command: 'yg tree', text: 'yg tree' },
    });
  });

  it('failAndExit exits 1 after writing', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('exit'); }) as never);
    expect(() => failAndExit({ what: 'w', why: 'y', next: 'n' })).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('notice writes a prefixed block to stderr', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    notice({ what: 'w', why: 'y', next: 'n' });
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('note: w\n  why:  y\nnext: n');
  });

  it('errorDocument carries a null command when the fix is prose', () => {
    const doc = errorDocument(fromIssueMessage({ what: 'w', why: 'y', next: 'Fix the YAML.' }, { code: 'yaml-invalid' }));
    expect(doc.next).toEqual({ command: null, text: 'Fix the YAML.' });
  });
});
