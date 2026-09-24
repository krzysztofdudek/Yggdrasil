// =============================================================================
// yg check says the same thing in both of its forms. Every item the yg-check/1
// document lists — a file (`files[]`), a violation (`violations[]`), an edge
// (`edges[]`) — appears in the `--details` text, and every member line the
// text lists under such a finding is an item of the document. The text may
// lay a fact out however it likes; it may not drop one or invent one (report
// principle: parity — every fact in text exists in JSON, and JSON never
// truncates).
//
// And no what / why / next the document carries lays itself out: the engine
// hands the renderer data, so no message string holds a newline followed by
// indentation (the static half of this guard is
// tests/unit/cli/output-guards.test.ts; this is the half that sees strings
// built at run time).
//
// Runs on the golden-corpus project states (tests/support/golden-corpus.ts):
// each state is built, the invocations the corpus records before its
// `check --json` are replayed (a state's fill, say), and then both forms of
// the same report are read side by side.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { GOLDEN_STATES, binPath, cliEnv } from '../support/golden-corpus.js';

interface JsonViolation { file: string; line: number | null; message: string }
interface JsonEdge { file: string; line: number | null; target: string }
interface JsonIssue {
  code: string;
  node?: string;
  unit?: string;
  label: string;
  what: string;
  why: string;
  next: string;
  files?: string[];
  violations?: JsonViolation[];
  edges?: JsonEdge[];
}
interface JsonGroup { label: string; why: string; next: string; members: number[] }
interface CheckDoc { schema: 'yg-check/1'; issues: JsonIssue[]; groups?: JsonGroup[] }
interface ErrorDoc { schema: 'yg-error/1'; what: string; why: string; next: { text: string } }

function run(root: string, args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('node', [binPath(), ...args], { cwd: root, encoding: 'utf-8', env: cliEnv() });
  return { stdout: r.stdout ?? '', status: r.status };
}

/** One finding block of the text: its label, and its `at:` member lines (overflow excluded). */
interface TextBlock { label: string; members: string[] }

function textBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = [];
  let cur: TextBlock | null = null;
  let inAt = false;
  for (const line of text.split('\n')) {
    const head = /^(?:error|warning)\[([^\]]+)\] /.exec(line);
    if (head !== null) { cur = { label: head[1], members: [] }; out.push(cur); inAt = false; continue; }
    if (cur === null) continue;
    if (line.trim() === '') { cur = null; continue; }
    const f = /^ {2}([a-z]+): +(.*)$/.exec(line);
    if (f !== null) { inAt = f[1] === 'at'; if (inAt) cur.members.push(f[2]); continue; }
    if (inAt && line.startsWith('        ') && !line.slice(8).startsWith('… +')) cur.members.push(line.slice(8));
    else if (!line.startsWith('        ')) inAt = false;
  }
  return out;
}

// The label a JSON issue and its text block share.
const ITEM_LABELS = (doc: CheckDoc): Set<string> =>
  new Set(doc.issues.filter((i) => i.files !== undefined || i.violations !== undefined || i.edges !== undefined).map((i) => i.label));

/** How a violation reads on a member line: `file:line  message` (first line of it). */
function violationText(v: JsonViolation): string {
  const where = v.line !== null && v.file !== '' ? `${v.file}:${v.line}  ` : v.file !== '' ? `${v.file}  ` : '';
  return `${where}${v.message.split('\n')[0]}`;
}

/** Whether a member line states this item. */
function states(member: string, item: { kind: 'file'; file: string } | { kind: 'violation'; v: JsonViolation } | { kind: 'edge'; e: JsonEdge }): boolean {
  const m = member.trim();
  if (item.kind === 'file') return m === item.file;
  if (item.kind === 'violation') return m === violationText(item.v) || m.endsWith(`  ${violationText(item.v)}`);
  const where = item.e.line !== null ? `${item.e.file}:${item.e.line}` : item.e.file;
  return m.includes(where) && m.includes(item.e.target);
}

type Item = Parameters<typeof states>[1];

function itemsOf(issue: JsonIssue): Item[] {
  return [
    ...(issue.files ?? []).map((file): Item => ({ kind: 'file', file })),
    ...(issue.violations ?? []).map((v): Item => ({ kind: 'violation', v })),
    ...(issue.edges ?? []).map((e): Item => ({ kind: 'edge', e })),
  ];
}

function describeItem(item: Item): string {
  return item.kind === 'file' ? item.file : item.kind === 'violation' ? violationText(item.v) : `${item.e.file}${item.e.line !== null ? `:${item.e.line}` : ''} → ${item.e.target}`;
}

/** Every what / why / next string of the document, with where it sits. */
function messageStrings(doc: CheckDoc | ErrorDoc): Array<[string, string]> {
  if (doc.schema === 'yg-error/1') return [['what', doc.what], ['why', doc.why], ['next.text', doc.next.text]];
  const out: Array<[string, string]> = [];
  doc.issues.forEach((i, n) => {
    out.push([`issues[${n}].what`, i.what], [`issues[${n}].why`, i.why], [`issues[${n}].next`, i.next]);
  });
  (doc.groups ?? []).forEach((g, n) => {
    out.push([`groups[${n}].why`, g.why], [`groups[${n}].next`, g.next]);
  });
  return out.filter(([, s]) => typeof s === 'string');
}

const STATES = GOLDEN_STATES.filter((s) => s.cases.some((c) => c.name === 'check-json'));

describe.skipIf(!existsSync(binPath()))('yg check: the JSON document and the --details text list the same items', () => {
  it('the corpus has a state for each kind of item, so each direction is exercised', () => {
    expect(STATES.map((s) => s.name)).toEqual(expect.arrayContaining(['synthetic-24', 'relations', 'fresh-init']));
  });

  for (const state of STATES) {
    describe(state.name, () => {
      let root = '';
      let doc: CheckDoc;
      let answered: CheckDoc | ErrorDoc;
      let text = '';

      beforeAll(() => {
        root = state.build();
        for (const c of state.cases) {
          if (c.name === 'check-json') break;
          run(root, c.args);
        }
        answered = JSON.parse(run(root, ['check', '--json']).stdout) as CheckDoc | ErrorDoc;
        // A run that could not check at all (no graph) answers with yg-error/1:
        // it lists no items, so only its message strings are held to account.
        doc = answered.schema === 'yg-check/1' ? answered : { schema: 'yg-check/1', issues: [] };
        text = run(root, ['check', '--details']).stdout;
      }, 180_000);

      afterAll(() => {
        if (root !== '') rmSync(root, { recursive: true, force: true });
      });

      it('every files[] / violations[] / edges[] item appears in the text', () => {
        const blocks = textBlocks(text);
        const missing: string[] = [];
        for (const issue of doc.issues) {
          const members = blocks.filter((b) => b.label === issue.label).flatMap((b) => b.members);
          for (const item of itemsOf(issue)) {
            if (!members.some((m) => states(m, item))) missing.push(`${issue.label}: ${describeItem(item)}`);
          }
        }
        expect(missing).toEqual([]);
      });

      it('every member line the text lists for such a finding is an item of the document', () => {
        const labels = ITEM_LABELS(doc);
        const invented: string[] = [];
        for (const b of textBlocks(text)) {
          if (!labels.has(b.label)) continue;
          const issues = doc.issues.filter((i) => i.label === b.label);
          const items = issues.flatMap(itemsOf);
          // The unit an entry is about heads the items listed under it.
          const units = new Set(issues.flatMap((i) => [i.node, i.unit].filter((u): u is string => u !== undefined)));
          for (const m of b.members) {
            if (units.has(m.trim())) continue;
            // A refusal's member line for a reviewer rule carries its reason, not an item.
            if (items.length === 0) continue;
            if (!items.some((item) => states(m, item))) invented.push(`${b.label}: ${m}`);
          }
        }
        expect(invented).toEqual([]);
      });

      it('no what / why / next string lays itself out (a newline followed by indentation)', () => {
        const laidOut = messageStrings(answered).filter(([, s]) => /\n[ \t]/.test(s)).map(([where, s]) => `${where}: ${JSON.stringify(s)}`);
        expect(laidOut).toEqual([]);
      });
    });
  }
});
