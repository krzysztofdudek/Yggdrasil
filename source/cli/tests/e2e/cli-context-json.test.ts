// =============================================================================
// CLI E2E — `yg context --json`, the machine-readable context package.
//
// Pins the public CLI surface (spawn the built bin.js). The text view of
// `yg context` is the only place in the product where a rule reaches its reader
// with its STATUS word; --json carries the same facts for a layer that must not
// parse prose. Every scenario asserts the document parses, carries the schema
// tag, and agrees with the text view's own claims about the same subject.
//
//   1. --node                → owner, chain, every effective rule with status,
//                              kind, channel provenance and read paths
//   2. --file (node-owned)   → the owner's rules, and stdout is JSON ALONE
//                              (no "file -> node" line ahead of it)
//   3. status parity         → advisory / draft / enforced match the text view
//   4. --file (type-covered) → owner.kind 'type', the type chain, dropped rules
//   5. --file (unmapped)     → owner.kind 'none' with reason 'unmapped', exit 1
//   6. --file (excluded)     → owner.kind 'none' with reason 'excluded', exit 0
//   7. --json with neither / both target flags → unchanged guided errors
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const LIFECYCLE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const TYPE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

interface ContextDoc {
  schema: string;
  target: { kind: string; path: string };
  owner: Record<string, string>;
  chain: Array<{ node: string | null; type: string }>;
  aspects: Array<{
    id: string;
    status: string;
    kind: string;
    name: string;
    description: string;
    channels: Array<{ number: number; kind: string; origin: string; declaredStatus?: string }>;
    impliedBy?: string[];
    read: string[];
  }>;
  dropped?: Array<{ id: string; reason: string }>;
}

/** Parse stdout as one JSON document — a stray prose line would throw here, which is the point. */
function parse(stdout: string): ContextDoc {
  return JSON.parse(stdout) as ContextDoc;
}

function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ctxjson-${label}-`));
  cpSync(source, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg context --json', () => {
  it('1: --node emits one yg-context/1 document naming the owner, the chain and every effective rule', () => {
    const dir = copyFixture(LIFECYCLE_FIXTURE, 'node');
    try {
      const { status, stdout } = run(['context', '--node', 'services/orders', '--json'], dir);
      expect(status).toBe(0);
      const doc = parse(stdout);
      expect(doc.schema).toBe('yg-context/1');
      expect(doc.target).toEqual({ kind: 'node', path: 'services/orders' });
      expect(doc.owner).toEqual({ kind: 'node', path: 'services/orders', type: 'service' });
      // Nearest first: the node itself, then its module parent.
      expect(doc.chain).toEqual([
        { node: 'services/orders', type: 'service' },
        { node: 'services', type: 'module' },
      ]);

      const ids = doc.aspects.map((a) => a.id);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toContain('has-doc-comment');
      expect(ids).toContain('no-todo-comments');
      expect(ids).toContain('requires-named-export');
      expect(ids).toContain('wip-rule');

      // Reviewer kind is inferred from the rule source the aspect actually ships.
      const doc1 = doc.aspects.find((a) => a.id === 'has-doc-comment')!;
      expect(doc1.kind).toBe('llm');
      expect(doc1.read).toEqual(['.yggdrasil/aspects/has-doc-comment/content.md']);
      expect(doc1.name).toBe('HasDocComment');
      expect(doc1.description).toContain('documentation comment');

      const todo = doc.aspects.find((a) => a.id === 'no-todo-comments')!;
      expect(todo.kind).toBe('deterministic');
      expect(todo.read).toEqual(['.yggdrasil/aspects/no-todo-comments/check.mjs']);
      // Two channels at once: the architecture type default AND the flow.
      const origins = todo.channels.map((c) => c.origin).sort();
      expect(origins).toEqual(['flow:order-processing', 'type:service']);
      expect(todo.channels.map((c) => c.kind).sort()).toEqual(['flow', 'own-type']);
      expect(todo.channels.map((c) => c.number).sort()).toEqual([3, 5]);

      // The node's OWN declaration is channel 1.
      const wip = doc.aspects.find((a) => a.id === 'wip-rule')!;
      expect(wip.channels).toEqual([
        { number: 1, kind: 'own', origin: 'own:services/orders', declaredStatus: 'draft' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: --file emits the owner component\'s rules and nothing but the document on stdout', () => {
    const dir = copyFixture(LIFECYCLE_FIXTURE, 'file');
    try {
      const plain = run(['context', '--file', 'src/services/orders.ts'], dir);
      expect(plain.stdout.startsWith('src/services/orders.ts -> services/orders')).toBe(true);

      const { status, stdout } = run(['context', '--file', 'src/services/orders.ts', '--json'], dir);
      expect(status).toBe(0);
      // The owner line the text view prints first must NOT be on stdout here.
      expect(stdout.trimStart().startsWith('{')).toBe(true);
      const doc = parse(stdout);
      expect(doc.target).toEqual({ kind: 'file', path: 'src/services/orders.ts' });
      expect(doc.owner).toEqual({ kind: 'node', path: 'services/orders', type: 'service' });
      expect(doc.aspects.map((a) => a.id)).toContain('wip-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: each rule carries the SAME effective status the text view prints for it', () => {
    const dir = copyFixture(LIFECYCLE_FIXTURE, 'status');
    try {
      const text = run(['context', '--file', 'src/services/orders.ts'], dir).stdout;
      const doc = parse(run(['context', '--file', 'src/services/orders.ts', '--json'], dir).stdout);
      for (const aspect of doc.aspects) {
        expect(text).toContain(`${aspect.id} [${aspect.status}]`);
      }
      // The fixture is chosen because it exercises all three status words.
      const statuses = new Set(doc.aspects.map((a) => a.status));
      expect(statuses).toContain('enforced');
      expect(statuses).toContain('advisory');
      expect(statuses).toContain('draft');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a file governed by its architecture type alone reports the type, its chain and the dropped rules', () => {
    const dir = copyFixture(TYPE_FIXTURE, 'type');
    try {
      const { status, stdout } = run(['context', '--file', 'src/svc/handler.ts', '--json'], dir);
      expect(status).toBe(0);
      const doc = parse(stdout);
      expect(doc.owner.kind).toBe('type');
      expect(doc.owner.typeId).toBe('svc');
      expect(doc.owner.chainTermination).toContain("stop at 'svc'");
      // No component at any level — that is what a null node records.
      expect(doc.chain).toEqual([{ node: null, type: 'svc' }]);
      expect(Array.isArray(doc.dropped)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a file no node maps and no type matches answers "unmapped" on stdout and still exits 1', () => {
    const dir = copyFixture(LIFECYCLE_FIXTURE, 'unmapped');
    try {
      mkdirSync(path.join(dir, 'src', 'services'), { recursive: true });
      writeFileSync(path.join(dir, 'scratch.ts'), 'export const x = 1;\n', 'utf-8');
      const { status, stdout, stderr } = run(['context', '--file', 'scratch.ts', '--json'], dir);
      expect(status).toBe(1);
      // The prose diagnostic still goes to stderr, unchanged.
      expect(stderr).toContain('has no graph coverage');
      const doc = parse(stdout);
      expect(doc.owner.kind).toBe('none');
      expect(doc.owner.reason).toBe('unmapped');
      expect(doc.owner.explanation.length).toBeGreaterThan(0);
      expect(doc.aspects).toEqual([]);
      expect(doc.chain).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: a path excluded from coverage by design answers "excluded" and exits 0', () => {
    const dir = copyFixture(LIFECYCLE_FIXTURE, 'excluded');
    try {
      const { status, stdout } = run(
        ['context', '--file', '.yggdrasil/yg-architecture.yaml', '--json'],
        dir,
      );
      expect(status).toBe(0);
      const doc = parse(stdout);
      expect(doc.owner.kind).toBe('none');
      expect(doc.owner.reason).toBe('excluded');
      expect(doc.owner.explanation).toContain('never scanned for coverage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: --json does not change the guided errors for a missing or doubled target', () => {
    const dir = copyFixture(LIFECYCLE_FIXTURE, 'guards');
    try {
      const neither = run(['context', '--json'], dir);
      expect(neither.status).toBe(1);
      expect(neither.stderr).toContain('No target specified.');
      expect(neither.stdout).toBe('');

      const both = run(
        ['context', '--node', 'services/orders', '--file', 'src/services/orders.ts', '--json'],
        dir,
      );
      expect(both.status).toBe(1);
      expect(both.stderr).toContain('Conflicting options.');
      expect(both.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
