// =============================================================================
// Guards on the CLI's communication system — the invariants the output layer
// exists for, pinned so they cannot quietly regress:
//
//   1. No rendered group repeats a member line. A block's `at:` field lists
//      each member once; a member said twice is noise that reads as two
//      findings (the log-entry-missing block once repeated its paragraph per
//      member).
//   2. No what / why / next string lays itself out. The engine emits data and
//      the renderer owns layout, so a message never carries a newline followed
//      by indentation: the renderer aligns every later line of a field under
//      its first (column 9), and a message that indents its own lines fights
//      it — "Either:\n  1. …" came out double-indented, a file list embedded
//      as "\n  src/a.ts" put two spaces into the yg-check/1 `what` a machine
//      reads.
//
// The JSON-vs-text parity of yg check lives in
// tests/e2e/cli-check-json-text-parity.test.ts; the directory-scoped rule
// that keeps output inside the layer is the repository's own
// output-through-layer aspect.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { formatOutput, type CheckView } from '../../../src/cli/check-render-views.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
} from '../../../src/formatters/lock-issue-messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(CLI_ROOT, 'src');
const CORPUS = path.join(CLI_ROOT, 'tests', 'fixtures', 'golden-corpus');

// ── Reading blocks out of a report ────────────────────────

/** One finding block of a text report: its heading and its `at:` member lines. */
interface ParsedBlock {
  heading: string;
  members: string[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Every block in a report: a heading line (`error[label] …`, `warning[…] …`,
 * `nomination …`) and the lines of its `at:` field — the first after the
 * label, then every continuation line (column 9) until the next field or the
 * end of the block. The overflow line (`… +K more`) is not a member.
 */
export function parseBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;
  let inAt = false;
  for (const raw of text.replace(ANSI, '').split('\n')) {
    const line = raw.replace(/^[✗!] /, '');
    if (/^(error|warning|note|nomination)(\[[^\]]*\])?:? /.test(line)) {
      current = { heading: line, members: [] };
      blocks.push(current);
      inAt = false;
      continue;
    }
    if (current === null) continue;
    if (line.trim() === '') { current = null; inAt = false; continue; }
    const labelled = /^ {2}([a-z]+): +(.*)$/.exec(line);
    if (labelled !== null) {
      inAt = labelled[1] === 'at';
      if (inAt) current.members.push(labelled[2]);
      continue;
    }
    if (inAt && /^ {8}/.test(line)) {
      const member = line.slice(8);
      if (!member.startsWith('… +')) current.members.push(member);
    } else if (!/^ {8}/.test(line)) {
      inAt = false;
    }
  }
  return blocks;
}

/** Each block whose `at:` field says one line twice, with the line. */
function repeatedMembers(text: string): string[] {
  const out: string[] = [];
  for (const b of parseBlocks(text)) {
    const seen = new Set<string>();
    for (const m of b.members) {
      if (seen.has(m)) out.push(`${b.heading}  ⟶  ${m}`);
      seen.add(m);
    }
  }
  return out;
}

function result(issues: CheckIssue[]): CheckResult {
  return {
    projectName: 'test',
    nodeCount: 3,
    nodeTypeCounts: new Map(),
    aspectCount: 2,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues,
    suggestedNext: 'yg check --approve',
    advisoryWarnings: issues.filter((i) => i.code === 'aspect-violation-advisory').length,
    draftSkipped: 0,
    verifiedDet: 0,
    verifiedLlm: 0,
    pairs: [],
  };
}

function detRefusal(node: string, reason: string): CheckIssue {
  return {
    severity: 'error',
    code: 'aspect-violation-enforced',
    rule: 'aspect-violation-enforced',
    nodePath: node,
    aspectId: 'no-todo',
    pairKind: 'deterministic',
    messageData: detRefusedMessage({ aspectId: 'no-todo', unitKey: `node:${node}`, reason }),
  };
}

function llmRefusal(node: string, reason: string): CheckIssue {
  return {
    severity: 'error',
    code: 'aspect-violation-enforced',
    rule: 'aspect-violation-enforced',
    nodePath: node,
    aspectId: 'readable-names',
    pairKind: 'llm',
    messageData: llmRefusedMessage({ aspectId: 'readable-names', unitKey: `node:${node}`, reason }),
  };
}

function unverified(node: string, aspect = 'readable-names'): CheckIssue {
  return {
    severity: 'error',
    code: 'unverified',
    rule: 'unverified',
    nodePath: node,
    aspectId: aspect,
    unitKey: `node:${node}`,
    pairKind: 'llm',
    messageData: unverifiedMessage({ aspectId: aspect, unitKey: `node:${node}` }),
  };
}

function logMissing(node: string): CheckIssue {
  return {
    severity: 'error',
    code: 'log-entry-missing',
    rule: 'log-entry-missing',
    nodePath: node,
    messageData: {
      what: `No fresh log entry for node '${node}' — its source changed but no justification entry exists.`,
      why: "Node type 'service' has log_required: true — every source change needs a log entry capturing WHY.",
      next: `yg log add --node ${node} --reason '<why this change was made>'`,
    },
  };
}

function relationBroken(node: string): CheckIssue {
  return {
    severity: 'error',
    code: 'relation-broken',
    rule: 'relation-broken',
    nodePath: node,
    messageData: {
      what: "Relation target 'app/svc-99' does not exist.",
      why: 'This node declares a dependency on a node the graph does not contain.',
      next: `Correct the target in .yggdrasil/model/${node}/yg-node.yaml relations, or remove the relation.`,
    },
  };
}

const VIEWS: Array<[string, CheckView]> = [
  ['full', { kind: 'full' }],
  ['details', { kind: 'details' }],
];

describe('no rendered group repeats a member line', () => {
  // Issue sets built to tempt a repeat: the same finding reported twice (a
  // pair the lock and the fill both surface, a relation seen from two passes),
  // many members that say the same sentence, a refusal whose violations share
  // a file.
  const sets: Array<[string, CheckIssue[]]> = [
    ['one script refusal reported twice', [
      detRefusal('app/a', 'src/a.ts:2: TODO marker left in shipped code'),
      detRefusal('app/a', 'src/a.ts:2: TODO marker left in shipped code'),
    ]],
    ['one reviewer refusal reported twice', [
      llmRefusal('app/a', 'The name `x` says nothing about what it holds.'),
      llmRefusal('app/a', 'The name `x` says nothing about what it holds.'),
    ]],
    ['script refusals across nodes, several violations in one file', [
      detRefusal('app/a', 'src/a.ts:2: TODO marker\nsrc/a.ts:9: TODO marker'),
      detRefusal('app/b', 'src/b.ts:2: TODO marker'),
    ]],
    ['one unverified pair reported twice, beside others', [
      unverified('app/a'), unverified('app/a'), unverified('app/b'), unverified('app/c', 'no-todo'),
    ]],
    ['a log entry owed by several nodes, one of them twice', [
      logMissing('app/a'), logMissing('app/b'), logMissing('app/b'), logMissing('app/c'),
    ]],
    ['a broken relation reported twice for one node', [
      relationBroken('app/a'), relationBroken('app/a'), relationBroken('app/b'),
    ]],
  ];

  for (const [name, issues] of sets) {
    for (const [viewName, view] of VIEWS) {
      it(`${name} — ${viewName} view`, () => {
        const text = formatOutput(result(issues), view, false, false);
        expect(parseBlocks(text).length).toBeGreaterThan(0);
        expect(repeatedMembers(text)).toEqual([]);
      });
    }
  }

  it('the parser sees a repeat when one is there (the guard can fail)', () => {
    const planted = 'error[refused] x\n  at:   app/a  src/a.ts:2  m\n        app/a  src/a.ts:2  m\n  why:  w\n';
    expect(repeatedMembers(planted)).toEqual(['error[refused] x  ⟶  app/a  src/a.ts:2  m']);
  });

  it('no block in the golden output corpus repeats a member line', () => {
    const offenders: string[] = [];
    let blocks = 0;
    for (const state of readdirSync(CORPUS)) {
      for (const f of readdirSync(path.join(CORPUS, state))) {
        const text = readFileSync(path.join(CORPUS, state, f), 'utf-8');
        blocks += parseBlocks(text).length;
        for (const r of repeatedMembers(text)) offenders.push(`${state}/${f}: ${r}`);
      }
    }
    expect(blocks).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

// ── Messages carry no layout ───────────────────────────────

/** The output layer itself lays text out; everything else hands it data. */
const LAYOUT_OWNERS = new Set(['cli/output.ts', 'cli/output-diagnostic.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** A literal text piece of an expression, as it reads at run time; `starts` when it opens a string. */
interface Piece {
  text: string;
  starts: boolean;
}

/** The literal text pieces of an expression: strings and template fragments. */
function literalPieces(node: ts.Node): Piece[] {
  const out: Piece[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) out.push({ text: n.text, starts: true });
    else if (ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push({ text: n.text, starts: false });
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * Whether a message's literal text lays itself out: a newline followed by
 * indentation in one piece (`'Either:\n  1. …'`), or — where the message is
 * assembled from lines — a string that opens with an indent of two or more
 * (`items.map((i) => `  ${i}`).join('\n')`, `'  ' + file`) beside a newline.
 */
function laysOut(pieces: Piece[]): boolean {
  if (pieces.some((p) => /\n[ \t]/.test(p.text))) return true;
  const joinsLines = pieces.some((p) => p.text.includes('\n'));
  return joinsLines && pieces.some((p) => p.starts && /^[ \t]{2,}/.test(p.text));
}

const MESSAGE_KEYS = new Set(['what', 'why', 'next']);

/** Every `what:` / `why:` / `next:` whose literal text puts indentation after a newline, as `file:line`. */
export function indentedMessageSites(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && MESSAGE_KEYS.has(n.name.text)) {
      if (laysOut(literalPieces(n.initializer))) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}  ${n.name.text}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('no what / why / next string lays itself out', () => {
  it('no message in the shipped source indents a line after a newline', () => {
    const offenders: string[] = [];
    for (const full of sourceFiles(SRC)) {
      const rel = path.relative(SRC, full).split(path.sep).join('/');
      if (LAYOUT_OWNERS.has(rel)) continue;
      offenders.push(...indentedMessageSites(rel, readFileSync(full, 'utf-8')));
    }
    expect(offenders).toEqual([]);
  });

  it('the scan finds a planted message that indents its own lines (the guard can fail)', () => {
    const planted = [
      "const a = { what: 'Two files:\\n  src/a.ts', why: 'w', next: 'n' };",
      'const b = { what: `x`, why: `y`, next: `Either:\\n  1. do it` };',
      "const c = { what: files.map((f) => f).join('\\n    '), why: '', next: '' };",
      "const e = { what: `Bad lines:\\n${rows.map((r) => `  line ${r}`).join('\\n')}`, why: '', next: '' };",
      "const f = { what: `${n} files:\\n${files.map((x) => '  ' + x).join('\\n')}`, why: '', next: '' };",
      // A separator that merely opens with a space is not an indent.
      "const g = { what: `A — ${a}\\n${b.join(' ')}`, why: '', next: '' };",
      // A newline with no indentation after it is prose, not layout.
      "const d = { what: 'Violations:\\nsrc/a.ts:2: m', why: 'w', next: 'n' };",
    ].join('\n');
    expect(indentedMessageSites('planted.ts', planted)).toEqual(['planted.ts:1  what', 'planted.ts:2  next', 'planted.ts:3  what', 'planted.ts:4  what', 'planted.ts:5  what']);
  });
});
