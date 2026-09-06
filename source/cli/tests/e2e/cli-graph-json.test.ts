// =============================================================================
// CLI E2E — the graph's two machine documents.
//
// `yg impact --json` (yg-impact/1) answers "who depends on this component, and
// what does it publish"; `yg node --json` (yg-node/1) answers "what IS this
// component". Both exist for a layer sitting ABOVE the agent — an orchestrator
// deriving work from the graph — which must never learn a fact by parsing
// prose, and must never be handed a file format to read by hand.
//
// Every scenario spawns the built bin.js and reads only stdout/stderr/exit code.
//
//   1. impact --node        → schema, subject, ports with consumers, dependents
//   2. impact --file        → byte-identical to --node on the owning component
//   3. impact, aspect/flow/type → refused, what/why/next, exit 1
//   4. impact --file, no owning component → refused on stderr, exit code kept
//   5. node --json          → identity, owned files, relations, ports, hierarchy
//   6. node --json, a parent → children listed, no ports, no rule set anywhere
//   7. node <unknown>       → refused, what/why/next, exit 1
//   8. node text view       → the same facts for a person
//   9. this repository's own graph → the port cli/io/atomic-write publishes
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PORTS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
// The repository this CLI is developed in — its own graph is a live example as
// well as the thing being enforced, so the documents are proved against it too.
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

interface ImpactDoc {
  schema: string;
  subject: { kind: string; path: string };
  ports: Array<{
    name: string;
    version: number | null;
    test: string | null;
    consumers: Array<{ node: string; relation: string }>;
  }>;
  dependents: Array<{ node: string; direct: boolean; relations: Array<{ type: string; ports: string[] }> }>;
  transitive: Array<{ node: string; via: string[] }>;
}

interface NodeDoc {
  schema: string;
  path: string;
  name: string;
  type: string;
  description: string;
  mapping: string[];
  relations: Array<{ target: string; type: string; consumes: string[]; event_name?: string }>;
  ports: Record<string, { description: string; version: number | null; test: string | null; aspects: string[] }>;
  children: string[];
  parent: string | null;
}

/** Parse stdout as ONE JSON document — a stray prose line would throw here, which is the point. */
function parse<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-graphjson-${label}-`));
  cpSync(source, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg impact --json and yg node --json', () => {
  it('1: impact --node names the subject, the ports it publishes and who depends on it', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'impact-node');
    try {
      const { status, stdout } = run(['impact', '--node', 'services/payments', '--json'], dir);
      expect(status).toBe(0);
      const doc = parse<ImpactDoc>(stdout);
      expect(doc.schema).toBe('yg-impact/1');
      expect(doc.subject).toEqual({ kind: 'node', path: 'services/payments' });

      // The published contract, and the component that consumes it.
      expect(doc.ports).toEqual([
        {
          name: 'charge',
          version: null,
          test: null,
          consumers: [{ node: 'services/orders', relation: 'uses' }],
        },
      ]);

      // The dependent declares the relation, so it is direct and names the port.
      expect(doc.dependents).toEqual([
        {
          node: 'services/orders',
          direct: true,
          relations: [{ type: 'uses', ports: ['charge'] }],
        },
      ]);
      // Nothing sits behind that dependent.
      expect(doc.transitive).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: impact --file resolves the owner and emits the SAME document, alone on stdout', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'impact-file');
    try {
      const byNode = run(['impact', '--node', 'services/payments', '--json'], dir);
      const byFile = run(['impact', '--file', 'src/services/payments.ts', '--json'], dir);
      expect(byFile.status).toBe(0);
      // Byte-identical: the owner-resolution line the text view prints is
      // suppressed, so stdout carries the document and nothing else.
      expect(byFile.stdout).toBe(byNode.stdout);
      expect(parse<ImpactDoc>(byFile.stdout).subject.path).toBe('services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: impact --json is refused for --aspect, --flow and --type with what/why/next', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'impact-refuse');
    try {
      for (const target of [['--aspect', 'audit-required'], ['--flow', 'nothing'], ['--type', 'provider']]) {
        const { status, stdout, stderr } = run(['impact', ...target, '--json'], dir);
        expect(status).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('--json is not available for --aspect, --flow, or --type.');
        expect(stderr).toContain('describes the blast radius of ONE component');
        expect(stderr).toContain('yg impact --node <path> --json');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: impact --file --json on a file no component owns refuses on stderr and keeps the exit code', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'impact-unowned');
    try {
      const text = run(['impact', '--file', 'src/services/nothing.ts'], dir);
      const json = run(['impact', '--file', 'src/services/nothing.ts', '--json'], dir);
      // Same verdict as the text view, and no half-document on stdout.
      expect(json.status).toBe(text.status);
      expect(json.stdout).toBe('');
      expect(json.stderr).toContain('no graph coverage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: node --json names identity, owned files, declared dependencies, ports and hierarchy', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'node-json');
    try {
      const { status, stdout } = run(['node', 'services/payments', '--json'], dir);
      expect(status).toBe(0);
      const doc = parse<NodeDoc>(stdout);
      expect(doc).toEqual({
        schema: 'yg-node/1',
        path: 'services/payments',
        name: 'PaymentsService',
        type: 'provider',
        description: 'Captures payments and exposes the charge port to consumers.',
        mapping: ['src/services/payments.ts'],
        relations: [],
        ports: {
          charge: {
            description: 'Capture a payment from the user.',
            version: null,
            test: null,
            aspects: ['audit-required'],
          },
        },
        children: [],
        parent: 'services',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: node --json on a parent lists its children, and a consumer names the port it consumes', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'node-parent');
    try {
      const parentDoc = parse<NodeDoc>(run(['node', 'services', '--json'], dir).stdout);
      expect(parentDoc.parent).toBeNull();
      expect(parentDoc.children).toEqual(['services/orders', 'services/payments']);
      expect(parentDoc.mapping).toEqual([]);
      expect(parentDoc.ports).toEqual({});

      const consumerDoc = parse<NodeDoc>(run(['node', 'services/orders', '--json'], dir).stdout);
      expect(consumerDoc.relations).toEqual([
        { target: 'services/payments', type: 'uses', consumes: ['charge'] },
      ]);
      // Structure only — the rule set is the context package's answer, and no
      // key of this document carries it.
      expect(Object.keys(consumerDoc)).not.toContain('aspects');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: node with a path naming no component is refused with what/why/next, exit 1', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'node-unknown');
    try {
      const { status, stdout, stderr } = run(['node', 'services/nope', '--json'], dir);
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain("Node 'services/nope' does not exist in the graph.");
      expect(stderr).toContain('directory under .yggdrasil/model/');
      expect(stderr).toContain('yg tree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: the text view carries the same facts for a person', () => {
    const dir = copyFixture(PORTS_FIXTURE, 'node-text');
    try {
      const { status, stdout } = run(['node', 'services/payments'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('services/payments — PaymentsService [provider]');
      expect(stdout).toContain('parent: services');
      expect(stdout).toContain('src/services/payments.ts');
      expect(stdout).toContain('charge — Capture a payment from the user.');
      expect(stdout).toContain('consumers must satisfy: audit-required');
      expect(stdout).toContain('yg context --node services/payments');
      // The text view is prose, never the machine document.
      expect(stdout).not.toContain('"schema"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("9: on this repository's own graph, the atomic-write component publishes its port to real consumers", () => {
    const impact = run(['impact', '--node', 'cli/io/atomic-write', '--json'], REPO_ROOT);
    expect(impact.status).toBe(0);
    const impactDoc = parse<ImpactDoc>(impact.stdout);
    expect(impactDoc.schema).toBe('yg-impact/1');
    expect(impactDoc.subject).toEqual({ kind: 'node', path: 'cli/io/atomic-write' });

    const port = impactDoc.ports.find((p) => p.name === 'write-atomic');
    expect(port).toBeDefined();
    expect(port!.consumers.map((c) => c.node)).toContain('cli/io/lock-store');
    // A consumer of the port declares the relation, so it is a direct dependent
    // that names the port it consumes.
    const lockStore = impactDoc.dependents.find((d) => d.node === 'cli/io/lock-store');
    expect(lockStore?.direct).toBe(true);
    expect(lockStore?.relations.some((r) => r.ports.includes('write-atomic'))).toBe(true);
    // Everything reached behind a direct dependent carries the path it came by.
    expect(impactDoc.transitive.length).toBeGreaterThan(0);
    for (const t of impactDoc.transitive) {
      expect(t.via.length).toBeGreaterThan(0);
      expect(t.via).not.toContain('cli/io/atomic-write');
      expect(t.via).not.toContain(t.node);
    }

    const nodeDoc = parse<NodeDoc>(run(['node', 'cli/io/atomic-write', '--json'], REPO_ROOT).stdout);
    expect(nodeDoc.schema).toBe('yg-node/1');
    expect(nodeDoc.path).toBe('cli/io/atomic-write');
    expect(nodeDoc.type).toBe('persistence-adapter');
    expect(nodeDoc.mapping).toEqual(['source/cli/src/io/atomic-write.ts']);
    expect(nodeDoc.parent).toBe('cli/io');
    expect(nodeDoc.ports['write-atomic'].aspects).toEqual(['atomic-write-contract']);
  });
});
