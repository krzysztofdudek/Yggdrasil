// =============================================================================
// Unit tests for the file-level half of `yg adopt` — recognizing a proposal,
// reading what its generator recorded, describing a graph that is already here,
// and moving one into place as a transaction that can be undone whole.
//
// Every case runs against REAL directories on disk, built in a temp location:
// the subject is filesystem behaviour, so a stand-in for the filesystem would
// prove nothing about it.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  countRulesByStatus,
  describeExistingGraph,
  graphDirExists,
  installGraph,
  looksLikeGraph,
  readExistingViolations,
  readProvenance,
  resolveProposal,
  rootComponentPath,
} from '../../../src/cli/adopt-transaction.js';
import type { Graph } from '../../../src/model/graph.js';

let root: string;

function w(rel: string, content: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return abs;
}

/** A staging directory shaped like the one a generator writes. */
function makeProposal(dir: string, opts: { metadata?: boolean; violations?: Record<string, number | null> } = {}): string {
  w(`${dir}/.yggdrasil/yg-config.yaml`, 'version: "5.2.0"\n');
  w(`${dir}/.yggdrasil/yg-architecture.yaml`, 'node_types:\n  service:\n    description: svc\n');
  if (opts.metadata !== false) {
    w(
      `${dir}/proposal.json`,
      JSON.stringify({ schema: 'grain-proposal/1', engine: '0.4.0', asOf: 'abc123', files: 7 }),
    );
  }
  for (const [aspectId, count] of Object.entries(opts.violations ?? {})) {
    w(
      `${dir}/.yggdrasil/aspects/${aspectId}/provenance.json`,
      JSON.stringify(count === null ? { aspectId } : { aspectId, existingViolations: count }),
    );
  }
  return path.join(root, dir);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'yg-adopt-unit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveProposal', () => {
  it('accepts a staging directory that contains a graph', async () => {
    const dir = makeProposal('staged');
    const resolved = await resolveProposal(dir);
    expect(resolved).not.toBeNull();
    expect(resolved!.root).toBe(dir);
    expect(resolved!.graphDir).toBe(path.join(dir, '.yggdrasil'));
  });

  it('accepts the graph directory itself, and puts its parent forward as the staging root', async () => {
    const dir = makeProposal('staged');
    const resolved = await resolveProposal(path.join(dir, '.yggdrasil'));
    expect(resolved!.root).toBe(dir);
    expect(resolved!.graphDir).toBe(path.join(dir, '.yggdrasil'));
  });

  it('refuses a directory holding no graph rather than searching upward for one', async () => {
    // The parent DOES hold a graph — a search upward would find it and quietly
    // propose adopting this repository's own graph over itself.
    makeProposal('staged');
    mkdirSync(path.join(root, 'staged', 'unrelated'), { recursive: true });
    expect(await resolveProposal(path.join(root, 'staged', 'unrelated'))).toBeNull();
  });

  it('refuses a path that is not a directory at all', async () => {
    w('notes.txt', 'hello\n');
    expect(await resolveProposal(path.join(root, 'notes.txt'))).toBeNull();
    expect(await resolveProposal(path.join(root, 'absent'))).toBeNull();
  });
});

describe('looksLikeGraph', () => {
  it('needs both files every graph has', async () => {
    const dir = makeProposal('staged');
    expect(await looksLikeGraph(path.join(dir, '.yggdrasil'))).toBe(true);

    mkdirSync(path.join(root, 'half', '.yggdrasil'), { recursive: true });
    w('half/.yggdrasil/yg-config.yaml', 'version: "5.2.0"\n');
    expect(await looksLikeGraph(path.join(root, 'half', '.yggdrasil'))).toBe(false);
  });
});

describe('readProvenance', () => {
  it('reports what the generator recorded, and recognizes a mined proposal', async () => {
    const dir = makeProposal('staged');
    const provenance = await readProvenance((await resolveProposal(dir))!);
    expect(provenance).toEqual({
      schema: 'grain-proposal/1',
      engine: '0.4.0',
      instrument: undefined,
      asOf: 'abc123',
      files: 7,
      mined: true,
    });
  });

  it('treats an absent or unreadable record as an ordinary absence, never a failure', async () => {
    const dir = makeProposal('bare', { metadata: false });
    expect(await readProvenance((await resolveProposal(dir))!)).toBeUndefined();

    w('garbled/proposal.json', '{ not json');
    w('garbled/.yggdrasil/yg-config.yaml', 'version: "5.2.0"\n');
    w('garbled/.yggdrasil/yg-architecture.yaml', 'node_types: {}\n');
    expect(await readProvenance((await resolveProposal(path.join(root, 'garbled')))!)).toBeUndefined();
  });

  it('does not call a hand-written proposal mined', async () => {
    w('hand/.yggdrasil/yg-config.yaml', 'version: "5.2.0"\n');
    w('hand/.yggdrasil/yg-architecture.yaml', 'node_types: {}\n');
    w('hand/proposal.json', JSON.stringify({ schema: 'something-else/2' }));
    const provenance = await readProvenance((await resolveProposal(path.join(root, 'hand')))!);
    expect(provenance!.mined).toBe(false);
  });
});

describe('readExistingViolations', () => {
  it('sums what each rule measured, and ranks the rules that already refuse something', async () => {
    const dir = makeProposal('staged', { violations: { alpha: 3, beta: 7, gamma: 0 } });
    const violations = await readExistingViolations(path.join(dir, '.yggdrasil'));
    expect(violations.measured).toBe(3);
    expect(violations.total).toBe(10);
    expect(violations.byAspect).toEqual([
      { aspectId: 'beta', count: 7 },
      { aspectId: 'alpha', count: 3 },
    ]);
  });

  it('keeps "not measured" apart from "measured as none"', async () => {
    const dir = makeProposal('staged', { violations: { alpha: null, beta: 0 } });
    const violations = await readExistingViolations(path.join(dir, '.yggdrasil'));
    expect(violations.measured).toBe(1);
    expect(violations.total).toBe(0);
    expect(violations.byAspect).toEqual([]);
  });

  it('reports nothing measured when the graph carries no rules at all', async () => {
    const dir = makeProposal('staged');
    expect(await readExistingViolations(path.join(dir, '.yggdrasil'))).toEqual({
      measured: 0,
      total: 0,
      byAspect: [],
    });
  });
});

describe('describeExistingGraph', () => {
  it('counts components, rules and flows without loading the graph', async () => {
    w('repo/.yggdrasil/model/alpha/yg-node.yaml', 'name: A\n');
    w('repo/.yggdrasil/model/alpha/child/yg-node.yaml', 'name: B\n');
    w('repo/.yggdrasil/aspects/one/yg-aspect.yaml', 'name: One\n');
    w('repo/.yggdrasil/flows/f/yg-flow.yaml', 'name: F\n');
    const summary = await describeExistingGraph(path.join(root, 'repo', '.yggdrasil'));
    expect(summary).toEqual({ components: 2, rules: 1, flows: 1, hasRecordedVerdicts: false });
  });

  it('reports a graph with verdicts recorded against it', async () => {
    w('repo/.yggdrasil/yg-lock.nondeterministic.json', '{}');
    const summary = await describeExistingGraph(path.join(root, 'repo', '.yggdrasil'));
    expect(summary.hasRecordedVerdicts).toBe(true);
    expect(summary.components).toBe(0);
  });
});

describe('countRulesByStatus / rootComponentPath', () => {
  const graph = (statuses: Array<string | undefined>, nodePaths: string[]): Graph =>
    ({
      aspects: statuses.map((status, i) => ({ id: `a${i}`, ...(status !== undefined && { status }) })),
      nodes: new Map(nodePaths.map((p) => [p, { path: p }])),
    }) as unknown as Graph;

  it('treats an undeclared status as enforced, the way the engine does', () => {
    expect(countRulesByStatus(graph(['enforced', 'advisory', 'draft', undefined], []))).toEqual({
      enforced: 2,
      advisory: 1,
      draft: 1,
    });
  });

  it('records an acceptance against the shallowest component, ties broken by name', () => {
    expect(rootComponentPath(graph([], ['a/b/c', 'zeta', 'alpha', 'a/b']))).toBe('alpha');
    expect(rootComponentPath(graph([], []))).toBeUndefined();
  });
});

describe('installGraph', () => {
  const stamp = (): Date => new Date('2026-01-02T03:04:05.678Z');

  it('moves the graph into place when the repository has none', async () => {
    const dir = makeProposal('staged');
    mkdirSync(path.join(root, 'repo'), { recursive: true });
    const tx = await installGraph(path.join(root, 'repo'), (await resolveProposal(dir))!, stamp);
    expect(tx.movedAsideTo).toBeUndefined();
    expect(existsSync(path.join(root, 'repo', '.yggdrasil', 'yg-config.yaml'))).toBe(true);
    expect(await graphDirExists(path.join(root, 'repo', '.yggdrasil'))).toBe(true);
  });

  it('keeps a previous graph aside rather than deleting it, and can put it back', async () => {
    const dir = makeProposal('staged');
    w('repo/.yggdrasil/yg-config.yaml', '# the one that was already here\n');
    const tx = await installGraph(path.join(root, 'repo'), (await resolveProposal(dir))!, stamp);
    expect(tx.movedAsideTo).toBeDefined();
    expect(path.basename(tx.movedAsideTo!).startsWith('.yggdrasil.replaced-')).toBe(true);
    expect(existsSync(path.join(tx.movedAsideTo!, 'yg-config.yaml'))).toBe(true);

    await tx.rollback();
    expect(readdirSync(path.join(root, 'repo'))).toEqual(['.yggdrasil']);
    expect(existsSync(path.join(root, 'repo', '.yggdrasil', 'yg-config.yaml'))).toBe(true);
  });

  it('rolling back an acceptance into an empty repository leaves nothing behind', async () => {
    const dir = makeProposal('staged');
    mkdirSync(path.join(root, 'repo'), { recursive: true });
    const tx = await installGraph(path.join(root, 'repo'), (await resolveProposal(dir))!, stamp);
    await tx.rollback();
    await tx.rollback(); // idempotent
    expect(readdirSync(path.join(root, 'repo'))).toEqual([]);
  });
});
