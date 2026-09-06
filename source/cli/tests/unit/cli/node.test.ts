// =============================================================================
// Unit — `yg node`, the component command.
//
// The command has two views over ONE document: the text view for a person and
// the yg-node/1 machine form for a layer above the agent. These tests spawn the
// built binary against real on-disk fixture projects and pin the properties the
// two views must share — same facts, same component, and a refusal that tells a
// caller what to do next.
// =============================================================================

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { NODE_JSON_SCHEMA } from '../../../src/formatters/node-json.js';
import type { NodeJsonDocument } from '../../../src/formatters/node-json.js';
import { buildNodeDocument } from '../../../src/core/graph/machine-documents.js';
import { loadGraph } from '../../../src/core/graph-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PORTS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-node-cmd-${label}-`));
  cpSync(PORTS_FIXTURE, dir, { recursive: true });
  return dir;
}

describe('yg node — the component document', () => {
  it('builds one document straight from the loaded graph, ports and hierarchy included', async () => {
    const graph = await loadGraph(PORTS_FIXTURE);
    const doc = buildNodeDocument(graph, 'services/payments');
    expect(doc.schema).toBe(NODE_JSON_SCHEMA);
    expect(doc.name).toBe('PaymentsService');
    expect(doc.parent).toBe('services');
    expect(doc.ports.charge.aspects).toEqual(['audit-required']);
    // Not yet declarable on a port — present as null so a consumer's reader
    // does not change shape the day they are.
    expect(doc.ports.charge.version).toBeNull();
    expect(doc.ports.charge.test).toBeNull();
  });

  it('gives a consumer its declared relation with the port it consumes', async () => {
    const graph = await loadGraph(PORTS_FIXTURE);
    const doc = buildNodeDocument(graph, 'services/orders');
    expect(doc.relations).toEqual([{ target: 'services/payments', type: 'uses', consumes: ['charge'] }]);
    expect(doc.children).toEqual([]);
  });

  it('gives a parent its children and no mapping of its own', async () => {
    const graph = await loadGraph(PORTS_FIXTURE);
    const doc = buildNodeDocument(graph, 'services');
    expect(doc.children).toEqual(['services/orders', 'services/payments']);
    expect(doc.parent).toBeNull();
    expect(doc.mapping).toEqual([]);
  });

  it.skipIf(!distExists)('emits the document alone on stdout under --json', () => {
    const dir = copyFixture('json');
    try {
      const { status, stdout } = run(['node', 'services/orders', '--json'], dir);
      expect(status).toBe(0);
      const doc = JSON.parse(stdout) as NodeJsonDocument;
      expect(doc.schema).toBe(NODE_JSON_SCHEMA);
      expect(doc.path).toBe('services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!distExists)('accepts a trailing slash on the path, like every other component argument', () => {
    const dir = copyFixture('trailing');
    try {
      const plain = run(['node', 'services/orders', '--json'], dir);
      const slashed = run(['node', 'services/orders/', '--json'], dir);
      expect(slashed.status).toBe(0);
      expect(slashed.stdout).toBe(plain.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!distExists)('refuses an unknown component with what, why and a next command', () => {
    const dir = copyFixture('unknown');
    try {
      const { status, stdout, stderr } = run(['node', 'services/ghost'], dir);
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain("Node 'services/ghost' does not exist in the graph.");
      expect(stderr).toContain('yg tree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!distExists)('names the component, its files, its ports and where its rules are, in the text view', () => {
    const dir = copyFixture('text');
    try {
      const { status, stdout } = run(['node', 'services/payments'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('services/payments — PaymentsService [provider]');
      expect(stdout).toContain('Owns (1):');
      expect(stdout).toContain('src/services/payments.ts');
      expect(stdout).toContain('Ports (1):');
      expect(stdout).toContain('version: (none)');
      expect(stdout).toContain('yg context --node services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
