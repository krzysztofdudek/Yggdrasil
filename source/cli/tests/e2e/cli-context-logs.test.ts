// =============================================================================
// CLI E2E — the logs `yg context` carries.
//
// An agent about to edit a file gets, beside the rules, what was decided about
// the code it touches: the decisions in force for the subject's type and every
// type above it (nearest first, each in full), and the owning component's own
// log (whole, or its newest entries when the type sets log_required). These
// scenarios pin that, in the text view and in yg-context/1 alike:
//
//   1. component → --node and --file on a component's file carry the type
//                  cascade (service, then module above it) and the node log;
//                  replaced entries are left out; a rule's own log never
//                  appears
//   2. trimmed   → a log_required node gives its newest 10 entries in force
//                  and says how many it left out; the text view names the
//                  command that reads the rest
//   3. type-only → a file governed by its type alone carries the type's
//                  decisions and no node log
//   4. nothing   → a subject with no log gets a document without the log
//                  fields and a text view without the headings
//   5. no hash   → the entries the context reads change no pair hash: a
//                  recorded project stays verified after type and node entries
//   6. broken    → a node log or a type log left with conflict markers is
//                  not given; the document says what is wrong and names
//                  merge-resolve for that log
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';
import { expectNoIssue, parseJson, type OutputIssue } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

interface Run { stdout: string; stderr: string; status: number | null; all: string }

function yg(dir: string, args: string[]): Run {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** The fixture with its one reviewer rule removed, so a recording run is free. */
function project(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ctxlog-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(arch, readFileSync(arch, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  return dir;
}

function edit(dir: string, rel: string, change: (s: string) => string): void {
  const p = path.join(dir, rel);
  writeFileSync(p, change(readFileSync(p, 'utf-8')), 'utf-8');
}

function addOk(dir: string, args: string[]): string {
  const r = yg(dir, ['log', 'add', ...args]);
  expect(r.status, r.all).toBe(0);
  const m = /Timestamp: (\S+)/.exec(r.stdout);
  expect(m, r.all).not.toBeNull();
  return m![1];
}

interface LogEntryDoc { datetime: string; body: string }
interface ContextDoc {
  schema: string;
  owner: { kind: string };
  typeDecisions?: Array<{ type: string; log: string; entries: LogEntryDoc[]; unreadable?: { what: string; why: string; next: string } }>;
  nodeLog?: { node: string; log: string; entries: LogEntryDoc[]; trimmed: boolean; omitted: number; unreadable?: { what: string; why: string; next: string } };
}

function contextJson(dir: string, args: string[]): ContextDoc {
  const r = yg(dir, ['context', ...args, '--json']);
  expect(r.status, r.all).toBe(0);
  return parseJson<ContextDoc>(r.stdout);
}

describe.skipIf(!distExists)('CLI E2E — yg context carries the type decisions in force and the node log', () => {
  it('1: a component carries its type cascade nearest first and its whole log; replaced entries and rule logs stay out', () => {
    const dir = project('component');
    try {
      addOk(dir, ['--type', 'module', '--reason', 'Each module groups the services of one bounded context.']);
      const http = addOk(dir, ['--type', 'service', '--reason', 'HTTP-DECISION: services talk over HTTP.', '--adds']);
      addOk(dir, ['--type', 'service', '--reason', 'QUEUE-DECISION: services talk over the queue.', '--supersedes', http]);
      const first = addOk(dir, ['--node', 'services/orders', '--reason', 'Orders are numbered by a database sequence.']);
      addOk(dir, ['--node', 'services/orders', '--reason', 'Orders are numbered client-side.', '--supersedes', first]);
      addOk(dir, ['--node', 'services/orders', '--reason', 'An order is immutable once paid.']);
      addOk(dir, ['--aspect', 'no-todo-comments', '--reason', 'RULE-LOG-MARKER: the rule now also rejects FIXME.']);

      for (const args of [['--node', 'services/orders'], ['--file', 'src/services/orders.ts']]) {
        const doc = contextJson(dir, args);
        expect(doc.schema).toBe('yg-context/1');
        expect(doc.typeDecisions?.map((t) => t.type)).toEqual(['service', 'module']);
        expect(doc.typeDecisions?.[0].log).toBe('.yggdrasil/types/service/log.md');
        expect(doc.typeDecisions?.[0].entries.map((e) => e.body.trim())).toEqual([`### Supersedes: ${http}\n\nQUEUE-DECISION: services talk over the queue.`]);
        expect(doc.typeDecisions?.[1].entries).toHaveLength(1);
        expect(doc.nodeLog?.node).toBe('services/orders');
        expect(doc.nodeLog?.log).toBe('.yggdrasil/model/services/orders/log.md');
        expect(doc.nodeLog?.trimmed).toBe(false);
        expect(doc.nodeLog?.omitted).toBe(0);
        expect(doc.nodeLog?.entries.map((e) => e.body)).not.toContainEqual(expect.stringContaining('database sequence'));
        expect(doc.nodeLog?.entries).toHaveLength(2);
        expect(JSON.stringify(doc)).not.toContain('RULE-LOG-MARKER');

        const text = yg(dir, ['context', ...args]);
        expect(text.status, text.all).toBe(0);
        const service = text.stdout.indexOf("Decisions in force for type 'service'");
        const module = text.stdout.indexOf("Decisions in force for type 'module'");
        const nodeLog = text.stdout.indexOf('Node log — why services/orders is the way it is');
        expect(service, text.stdout).toBeGreaterThan(-1);
        expect(module).toBeGreaterThan(service);
        expect(nodeLog).toBeGreaterThan(module);
        expect(text.stdout).toContain('QUEUE-DECISION');
        expect(text.stdout).not.toContain('HTTP-DECISION');
        expect(text.stdout).not.toContain('database sequence');
        expect(text.stdout).not.toContain('RULE-LOG-MARKER');
      }
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('2: a log_required node gives its newest 10 entries in force and names the rest', () => {
    const dir = project('trimmed');
    try {
      edit(dir, '.yggdrasil/yg-architecture.yaml', (s) => s.replace(/(service:\n(?:.*\n)*?\s+)log_required: false/, '$1log_required: true'));
      for (let i = 1; i <= 12; i++) addOk(dir, ['--node', 'services/payments', '--reason', `Payment decision number ${i}.`]);

      const doc = contextJson(dir, ['--node', 'services/payments']);
      expect(doc.nodeLog?.trimmed).toBe(true);
      expect(doc.nodeLog?.omitted).toBe(2);
      expect(doc.nodeLog?.entries).toHaveLength(10);
      expect(doc.nodeLog?.entries[0].body).toContain('number 3.');
      expect(doc.nodeLog?.entries[9].body).toContain('number 12.');

      const text = yg(dir, ['context', '--node', 'services/payments']).stdout;
      expect(text).not.toContain('Payment decision number 2.');
      expect(text).toContain('Payment decision number 12.');
      expect(text).toContain('yg log read --node services/payments --all');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('3: a file governed by its type alone carries the type decisions and no node log', () => {
    const dir = project('type-only');
    try {
      edit(dir, '.yggdrasil/yg-config.yaml', (s) => `${s.trimEnd()}\ncoverage:\n  type_level: true\n`);
      writeFileSync(path.join(dir, 'src', 'services', 'refunds.ts'), '/** Refunds. */\nexport const refund = 1;\n', 'utf-8');
      addOk(dir, ['--type', 'module', '--reason', 'Each module groups the services of one bounded context.']);
      addOk(dir, ['--type', 'service', '--reason', 'TABLE-DECISION: every service owns its table.', '--adds']);
      addOk(dir, ['--node', 'services/orders', '--reason', 'ORDERS-NODE-MARKER.']);

      const doc = contextJson(dir, ['--file', 'src/services/refunds.ts']);
      expect(doc.owner.kind).toBe('type');
      expect(doc.typeDecisions?.map((t) => t.type)).toEqual(['service', 'module']);
      expect(doc.nodeLog).toBeUndefined();

      const text = yg(dir, ['context', '--file', 'src/services/refunds.ts']);
      expect(text.status, text.all).toBe(0);
      expect(text.stdout).toContain('  Decisions in force');
      expect(text.stdout).toContain('TABLE-DECISION');
      expect(text.stdout).not.toContain('Node log');
      expect(text.stdout).not.toContain('ORDERS-NODE-MARKER');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('4: a subject with no log gets neither the fields nor the headings', () => {
    const dir = project('nothing');
    try {
      const doc = contextJson(dir, ['--node', 'services/orders']);
      expect('typeDecisions' in doc).toBe(false);
      expect('nodeLog' in doc).toBe(false);
      const text = yg(dir, ['context', '--node', 'services/orders']).stdout;
      expect(text).not.toContain('Decisions in force');
      expect(text).not.toContain('Node log');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('5: the entries the context reads change no pair hash — a recorded project stays verified', () => {
    const dir = project('no-hash');
    try {
      const recorded = yg(dir, ['check', '--approve', '--only-deterministic']);
      expect(recorded.status, recorded.all).toBe(0);
      addOk(dir, ['--type', 'service', '--reason', 'Every service owns its own table.']);
      addOk(dir, ['--node', 'services/orders', '--reason', 'An order is immutable once paid.']);
      expect(contextJson(dir, ['--node', 'services/orders']).nodeLog?.entries).toHaveLength(1);
      const after = yg(dir, ['check']);
      expect(after.status, after.all).toBe(0);
      expectNoIssue(parseJson<{ issues: OutputIssue[] }>(yg(dir, ['check', '--json']).stdout), { code: 'unverified' });
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('6: a node or type log left with conflict markers is not given, and the document names the step that repairs it', () => {
    const dir = project('broken');
    try {
      addOk(dir, ['--node', 'services/orders', '--reason', 'An order is immutable once paid.']);
      addOk(dir, ['--type', 'service', '--reason', 'Every service owns its own table.']);
      const markers = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
      for (const rel of [['model', 'services', 'orders', 'log.md'], ['types', 'service', 'log.md']]) {
        const log = path.join(dir, '.yggdrasil', ...rel);
        writeFileSync(log, `${readFileSync(log, 'utf-8')}${markers}`, 'utf-8');
      }
      const doc = contextJson(dir, ['--node', 'services/orders']);
      expect(doc.nodeLog?.entries).toEqual([]);
      expect(doc.nodeLog?.unreadable?.next).toBe('yg log merge-resolve --node services/orders');
      expect(doc.typeDecisions?.[0].type).toBe('service');
      expect(doc.typeDecisions?.[0].entries).toEqual([]);
      expect(doc.typeDecisions?.[0].unreadable?.next).toBe('yg log merge-resolve --type service');
      const text = yg(dir, ['context', '--node', 'services/orders']).stdout;
      expect(text).not.toContain('theirs');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });
});
