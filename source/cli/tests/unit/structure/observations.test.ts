// Goldens pin that runStructureAspect records result-bearing observations alongside
// the existing touchedFiles mechanism. A cached deterministic verdict is only
// reusable when every probe the check made (reads, listings, existence checks, graph
// node accesses) returned the same value — so the runner records WHAT each probe
// returned, not just which paths were visited.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import {
  observationKey,
  hashReadObservation,
  hashExistsObservation,
  hashNodeSetObservation,
  MISSING_OBSERVATION,
} from '../../../src/core/pair-hash.js';
import { ObservationRecorder } from '../../../src/structure/observations.js';

describe('ObservationRecorder — unit', () => {
  it('tainted=false in clean run with no conflicts', () => {
    const rec = new ObservationRecorder();
    rec.recordRead('src/a.ts', Buffer.from('hello'));
    rec.recordExists('src/b.ts', 'file');
    rec.recordList('src/', [{ name: 'a.ts', kind: 'file' }]);
    expect(rec.tainted).toBe(false);
  });

  it('dedup — same key same hash → one entry', () => {
    const rec = new ObservationRecorder();
    rec.recordRead('src/a.ts', Buffer.from('hello'));
    rec.recordRead('src/a.ts', Buffer.from('hello'));
    const snap = rec.snapshot();
    const readEntries = snap.filter(([k]) => k.startsWith('read:src/a.ts'));
    expect(readEntries).toHaveLength(1);
  });

  it('sorted output — keys come back in code-point order', () => {
    const rec = new ObservationRecorder();
    rec.recordExists('z.ts', 'file');
    rec.recordExists('a.ts', false);
    rec.recordRead('m.ts', Buffer.from('x'));
    const snap = rec.snapshot();
    const keys = snap.map(([k]) => k);
    expect(keys).toEqual([...keys].sort());
  });

  it('taint: same key different hash → tainted=true, first hash wins', () => {
    const rec = new ObservationRecorder();
    const buf1 = Buffer.from('first');
    const buf2 = Buffer.from('second');
    rec.recordRead('src/a.ts', buf1);
    rec.recordRead('src/a.ts', buf2);
    expect(rec.tainted).toBe(true);
    const snap = rec.snapshot();
    const entry = snap.find(([k]) => k === observationKey('read', 'src/a.ts'));
    // First hash wins
    expect(entry?.[1]).toBe(hashReadObservation(buf1));
  });

  it('no taint for distinct keys with distinct hashes', () => {
    const rec = new ObservationRecorder();
    rec.recordRead('src/a.ts', Buffer.from('aaa'));
    rec.recordRead('src/b.ts', Buffer.from('bbb'));
    expect(rec.tainted).toBe(false);
  });

  it('recordGraphNodeAbsent folds the MISSING_OBSERVATION token under graph: key', () => {
    const rec = new ObservationRecorder();
    rec.recordGraphNodeAbsent('does/not/exist');
    const snap = rec.snapshot();
    const entry = snap.find(([k]) => k === observationKey('graph', 'does/not/exist'));
    expect(entry?.[1]).toBe(MISSING_OBSERVATION);
  });

  it('recordGraphChildren folds the set membership (order-independent)', () => {
    const rec1 = new ObservationRecorder();
    rec1.recordGraphChildren('parent', ['parent/a', 'parent/b']);
    const rec2 = new ObservationRecorder();
    rec2.recordGraphChildren('parent', ['parent/b', 'parent/a']); // reordered
    const k = observationKey('graph-children', 'parent');
    const h1 = rec1.snapshot().find(([key]) => key === k)![1];
    const h2 = rec2.snapshot().find(([key]) => key === k)![1];
    expect(h1).toBe(h2); // order does not matter
    expect(h1).toBe(hashNodeSetObservation(['parent/a', 'parent/b']));
    // Adding a child changes the hash.
    const rec3 = new ObservationRecorder();
    rec3.recordGraphChildren('parent', ['parent/a', 'parent/b', 'parent/c']);
    expect(rec3.snapshot().find(([key]) => key === k)![1]).not.toBe(h1);
  });

  it('recordGraphNodesByType folds by-type set membership', () => {
    const rec = new ObservationRecorder();
    rec.recordGraphNodesByType('command', ['x', 'y']);
    const k = observationKey('graph-bytype', 'command');
    expect(rec.snapshot().find(([key]) => key === k)![1]).toBe(hashNodeSetObservation(['x', 'y']));
  });

  it('recordFlowParticipants folds the flow participant set', () => {
    const rec = new ObservationRecorder();
    rec.recordFlowParticipants('checkout', ['a', 'b']);
    const k = observationKey('graph-flow', 'checkout');
    expect(rec.snapshot().find(([key]) => key === k)![1]).toBe(hashNodeSetObservation(['a', 'b']));
  });

  it('recordReadAbsent / recordListAbsent fold MISSING_OBSERVATION', () => {
    const rec = new ObservationRecorder();
    rec.recordReadAbsent('src/gone.ts');
    rec.recordListAbsent('src/gonedir');
    const snap = rec.snapshot();
    expect(snap.find(([k]) => k === observationKey('read', 'src/gone.ts'))![1]).toBe(MISSING_OBSERVATION);
    expect(snap.find(([k]) => k === observationKey('list', 'src/gonedir'))![1]).toBe(MISSING_OBSERVATION);
  });

  it('empty node set folds to a stable hash distinct from MISSING_OBSERVATION', () => {
    const emptyHash = hashNodeSetObservation([]);
    expect(emptyHash).not.toBe(MISSING_OBSERVATION);
    // A later first member changes it.
    expect(hashNodeSetObservation(['n'])).not.toBe(emptyHash);
  });
});

describe('runStructureAspect — observation recording', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-obs-test-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const y = 2;');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function writeAspect(aspectId: string, checkBody: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
    return aspectDir;
  }

  it('out-of-subject fs.read → read: key with correct hash', async () => {
    // src/b.ts is NOT in the node mapping (which is only src/a.ts), so reading it
    // via ctx.fs.read is an out-of-subject operation and must record a read: observation.
    await writeAspect('obs-read', `
      export function check(ctx) {
        ctx.fs.read('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-read'),
      aspectId: 'obs-read', nodePath: 'N', graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    const expectedKey = observationKey('read', 'src/b.ts');
    const expectedHash = hashReadObservation(Buffer.from('export const y = 2;'));
    const entry = r.observations.find(([k]) => k === expectedKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(expectedHash);
    expect(r.observationsTainted).toBe(false);
  });

  it('fs.list → list: key whose hash changes when a file is added', async () => {
    // First run: list src/ with only a.ts and b.ts
    await writeAspect('obs-list', `
      export function check(ctx) {
        ctx.fs.list('src');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });

    const r1 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-list'),
      aspectId: 'obs-list', nodePath: 'N', graph: g, projectRoot,
    });
    const listKey = observationKey('list', 'src');
    const entry1 = r1.observations.find(([k]) => k === listKey);
    expect(entry1).toBeDefined();

    // Add a file to src/ and run again — the hash must change
    writeFileSync(path.join(projectRoot, 'src', 'c.ts'), 'export const z = 3;');
    const r2 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-list'),
      aspectId: 'obs-list', nodePath: 'N', graph: g, projectRoot,
    });
    const entry2 = r2.observations.find(([k]) => k === listKey);
    expect(entry2).toBeDefined();
    // Hash changed because directory contents changed
    expect(entry1![1]).not.toBe(entry2![1]);
  });

  it('NEGATIVE fs.exists probe → exists: key with hash of "false" token', async () => {
    // src/missing.ts is declared in the relation target mapping but does not exist
    // on disk — the exists() probe returns false and must record it as an observation.
    // We declare it in the mapping so the allowedSet admits the path.
    await writeAspect('obs-exists-false', `
      export function check(ctx) {
        ctx.fs.exists('src/missing.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/missing.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-exists-false'),
      aspectId: 'obs-exists-false', nodePath: 'N', graph: g, projectRoot,
    });
    const existsKey = observationKey('exists', 'src/missing.ts');
    const entry = r.observations.find(([k]) => k === existsKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashExistsObservation(false));
  });

  it('positive fs.exists → exists: key with hash of "file" token', async () => {
    // src/b.ts exists on disk and is accessible via a relation — the exists()
    // probe returns 'file' and must record that result as an observation.
    // src/a.ts is a subject file and must NOT produce an observation even if checked.
    await writeAspect('obs-exists-file', `
      export function check(ctx) {
        ctx.fs.exists('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-exists-file'),
      aspectId: 'obs-exists-file', nodePath: 'N', graph: g, projectRoot,
    });
    // src/b.ts is an out-of-subject file — must be recorded as 'file'
    const existsKey = observationKey('exists', 'src/b.ts');
    const entry = r.observations.find(([k]) => k === existsKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashExistsObservation('file'));
    expect(r.observationsTainted).toBe(false);
  });

  it('ctx.graph.node() → graph: key for the accessed node', async () => {
    // The current node itself is accessible via ctx.graph.node(). Its yaml bytes
    // must be recorded as a graph: observation.
    await writeAspect('obs-graph-node', `
      export function check(ctx) {
        ctx.graph.node(ctx.node.id);
        return [];
      }
    `);
    // Create the yg-node.yaml that ctx-graph will look up
    const modelDir = path.join(projectRoot, '.yggdrasil', 'model', 'N');
    mkdirSync(modelDir, { recursive: true });
    const nodeYaml = 'name: N\ntype: module\nmapping:\n  - src/a.ts\n';
    writeFileSync(path.join(modelDir, 'yg-node.yaml'), nodeYaml);

    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-graph-node'),
      aspectId: 'obs-graph-node', nodePath: 'N', graph: g, projectRoot,
    });
    const graphKey = observationKey('graph', 'N');
    const entry = r.observations.find(([k]) => k === graphKey);
    expect(entry).toBeDefined();
    // The graph node in our test has no nodeYamlRaw (minimal graph stub) so the
    // recorder falls back to reading the file from disk — verify the hash matches.
    expect(entry![1]).toBe(hashReadObservation(Buffer.from(nodeYaml)));
  });

  it('nodesByType returning N nodes → N graph: observations', async () => {
    await writeAspect('obs-nodes-by-type', `
      export function check(ctx) {
        ctx.graph.nodesByType('module');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-nodes-by-type'),
      aspectId: 'obs-nodes-by-type', nodePath: 'N', graph: g, projectRoot,
    });
    // Both N and Dep are type 'module' and in the allowed set (via relation)
    const graphObs = r.observations.filter(([k]) => k.startsWith('graph:'));
    expect(graphObs.length).toBeGreaterThanOrEqual(2);
    const keys = graphObs.map(([k]) => k);
    expect(keys).toContain(observationKey('graph', 'N'));
    expect(keys).toContain(observationKey('graph', 'Dep'));
  });

  it('subject-file read NOT duplicated as observation', async () => {
    // src/a.ts is in the node mapping (subject file) — reading it via ctx.fs.read
    // must NOT produce a read: observation since it is already hashed as a subject input.
    await writeAspect('obs-subject-skip', `
      export function check(ctx) {
        ctx.fs.read('src/a.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-subject-skip'),
      aspectId: 'obs-subject-skip', nodePath: 'N', graph: g, projectRoot,
    });
    const readKey = observationKey('read', 'src/a.ts');
    const entry = r.observations.find(([k]) => k === readKey);
    expect(entry).toBeUndefined();
  });

  it('snapshot is sorted in code-point order', async () => {
    await writeAspect('obs-sort', `
      export function check(ctx) {
        ctx.fs.exists('src/nonexistent.ts');
        ctx.fs.read('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-sort'),
      aspectId: 'obs-sort', nodePath: 'N', graph: g, projectRoot,
    });
    const keys = r.observations.map(([k]) => k);
    expect(keys).toEqual([...keys].sort());
    expect(r.observationsTainted).toBe(false);
  });

  it('tainted=false in clean multi-observation run', async () => {
    await writeAspect('obs-notainted', `
      export function check(ctx) {
        ctx.fs.exists('src/b.ts');
        ctx.fs.read('src/b.ts');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-notainted'),
      aspectId: 'obs-notainted', nodePath: 'N', graph: g, projectRoot,
    });
    expect(r.observationsTainted).toBe(false);
  });

  it('tainted=true when same key observed with different hashes (simulated via recorder)', () => {
    // We can only simulate a mid-run content change by directly calling the recorder,
    // since check.mjs cannot perform writes. This validates the first-hash-wins contract.
    const rec = new ObservationRecorder();
    const buf1 = Buffer.from('version A');
    const buf2 = Buffer.from('version B');
    rec.recordRead('src/shared.ts', buf1);
    rec.recordRead('src/shared.ts', buf2);
    expect(rec.tainted).toBe(true);
    const snap = rec.snapshot();
    const entry = snap.find(([k]) => k === observationKey('read', 'src/shared.ts'));
    // First-hash-wins
    expect(entry?.[1]).toBe(hashReadObservation(buf1));
  });

  it('positive exists: hash differs from negative exists: hash', () => {
    // The three outcomes ('file', 'dir', false) must produce distinct hashes.
    const fileHash = hashExistsObservation('file');
    const dirHash = hashExistsObservation('dir');
    const falseHash = hashExistsObservation(false);
    expect(fileHash).not.toBe(dirHash);
    expect(fileHash).not.toBe(falseHash);
    expect(dirHash).not.toBe(falseHash);
  });

  it('relationsFrom → graph: observation for the queried node', async () => {
    // A check that calls ctx.graph.relationsFrom(ctx.node) must record a graph:
    // observation for that node — its yg-node.yaml is an input to the result.
    await writeAspect('obs-relations-from', `
      export function check(ctx) {
        ctx.graph.relationsFrom(ctx.node);
        return [];
      }
    `);
    const modelDir = path.join(projectRoot, '.yggdrasil', 'model', 'N');
    mkdirSync(modelDir, { recursive: true });
    const nodeYaml = 'name: N\ntype: module\nmapping:\n  - src/a.ts\n';
    writeFileSync(path.join(modelDir, 'yg-node.yaml'), nodeYaml);

    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-relations-from'),
      aspectId: 'obs-relations-from', nodePath: 'N', graph: g, projectRoot,
    });
    const graphKey = observationKey('graph', 'N');
    const entry = r.observations.find(([k]) => k === graphKey);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashReadObservation(Buffer.from(nodeYaml)));
    expect(r.observationsTainted).toBe(false);
  });

  it('relationsTo → graph: observations for every scanned node', async () => {
    // A check that calls ctx.graph.relationsTo(ctx.node) must record graph:
    // observations for every node in the allowed set that was scanned — including
    // nodes that have NO relation to the current node (their absence is an input).
    //
    // Setup: N → Dep (puts Dep in the allowed set). Dep → N (so relationsTo(N)
    // finds a result). Both N and Dep are scanned; both must get graph: observations.
    await writeAspect('obs-relations-to', `
      export function check(ctx) {
        ctx.graph.relationsTo(ctx.node);
        return [];
      }
    `);
    const modelDirN = path.join(projectRoot, '.yggdrasil', 'model', 'N');
    const modelDirDep = path.join(projectRoot, '.yggdrasil', 'model', 'Dep');
    mkdirSync(modelDirN, { recursive: true });
    mkdirSync(modelDirDep, { recursive: true });
    const nodeYamlN = 'name: N\ntype: module\nmapping:\n  - src/a.ts\n';
    const nodeYamlDep = 'name: Dep\ntype: module\nmapping:\n  - src/b.ts\nrelations:\n  - type: uses\n    target: N\n';
    writeFileSync(path.join(modelDirN, 'yg-node.yaml'), nodeYamlN);
    writeFileSync(path.join(modelDirDep, 'yg-node.yaml'), nodeYamlDep);

    // N has a relation to Dep (adds Dep to allowed), and Dep has a relation back to N
    // (so relationsTo(N) returns a result from Dep).
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'], relations: [{ type: 'uses', target: 'N' }] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-relations-to'),
      aspectId: 'obs-relations-to', nodePath: 'N', graph: g, projectRoot,
    });
    const graphObs = r.observations.filter(([k]) => k.startsWith('graph:'));
    const keys = graphObs.map(([k]) => k);
    // Both nodes are in the allowed set; both should have graph: observations.
    expect(keys).toContain(observationKey('graph', 'N'));
    expect(keys).toContain(observationKey('graph', 'Dep'));
    expect(r.observationsTainted).toBe(false);
  });

  it('relationsTo: editing related yg-node.yaml changes its graph: hash', async () => {
    // After editing Dep's yg-node.yaml (adding a relation back to N), a fresh run
    // of relationsTo must produce a different graph: hash for Dep — proving the
    // relation declarations of scanned nodes are captured in the observation baseline.
    //
    // Setup: N → Dep always (puts Dep in allowed). Before: Dep has no relation to N.
    // After: Dep gains a relation to N. The graph: hash for Dep must change.
    await writeAspect('obs-relations-to-hash-change', `
      export function check(ctx) {
        ctx.graph.relationsTo(ctx.node);
        return [];
      }
    `);
    const modelDirDep = path.join(projectRoot, '.yggdrasil', 'model', 'Dep');
    mkdirSync(path.join(projectRoot, '.yggdrasil', 'model', 'N'), { recursive: true });
    mkdirSync(modelDirDep, { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      'name: N\ntype: module\nmapping:\n  - src/a.ts\n',
    );
    // Before: Dep has no relation to N
    const nodeYamlDepBefore = 'name: Dep\ntype: module\nmapping:\n  - src/b.ts\n';
    fsWriteFileSync(path.join(modelDirDep, 'yg-node.yaml'), nodeYamlDepBefore);

    // N → Dep (puts Dep in allowed); Dep has no back-relation yet.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r1 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-relations-to-hash-change'),
      aspectId: 'obs-relations-to-hash-change', nodePath: 'N', graph: g, projectRoot,
    });
    const depKey = observationKey('graph', 'Dep');
    const entry1 = r1.observations.find(([k]) => k === depKey);
    expect(entry1).toBeDefined();

    // After: Dep gains a relation to N (yg-node.yaml changes on disk)
    const nodeYamlDepAfter = 'name: Dep\ntype: module\nmapping:\n  - src/b.ts\nrelations:\n  - type: uses\n    target: N\n';
    fsWriteFileSync(path.join(modelDirDep, 'yg-node.yaml'), nodeYamlDepAfter);

    // Rebuild graph with the updated relation to reflect the new state.
    const g2 = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'], relations: [{ type: 'uses', target: 'N' }] },
      ],
    });
    const r2 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-relations-to-hash-change'),
      aspectId: 'obs-relations-to-hash-change', nodePath: 'N', graph: g2, projectRoot,
    });
    const entry2 = r2.observations.find(([k]) => k === depKey);
    expect(entry2).toBeDefined();
    // Hash must have changed because Dep's yg-node.yaml content changed.
    expect(entry1![1]).not.toBe(entry2![1]);
  });

  // Bug 2 — a NEGATIVE ctx.graph.node() lookup folds an absent graph: observation.
  it('ctx.graph.node() returning undefined → graph: observation with MISSING token', async () => {
    // 'Ghost' is a relation target (so it is in the allowed set and the lookup is
    // permitted) but has NO node in the graph — node('Ghost') returns undefined.
    await writeAspect('obs-absent-node', `
      export function check(ctx) {
        const n = ctx.graph.node('Ghost');
        if (n !== undefined) return [{ message: 'expected undefined' }];
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Ghost' }] },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-absent-node'),
      aspectId: 'obs-absent-node', nodePath: 'N', graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    const entry = r.observations.find(([k]) => k === observationKey('graph', 'Ghost'));
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(MISSING_OBSERVATION);
  });

  // Bug 3 — ctx.graph.children() folds the child-set membership.
  it('ctx.graph.children() → graph-children: set observation', async () => {
    await writeAspect('obs-children', `
      export function check(ctx) {
        ctx.graph.children(ctx.node);
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'] },
        { path: 'N/child1', type: 'module', mapping: ['src/c1.ts'], parent: 'N' },
        { path: 'N/child2', type: 'module', mapping: ['src/c2.ts'], parent: 'N' },
      ],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-children'),
      aspectId: 'obs-children', nodePath: 'N', graph: g, projectRoot,
    });
    const key = observationKey('graph-children', 'N');
    const entry = r.observations.find(([k]) => k === key);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashNodeSetObservation(['N/child1', 'N/child2']));
  });

  // Bug 3 — ctx.graph.nodesByType() folds by-type set; adding a node changes it.
  it('ctx.graph.nodesByType() → graph-bytype: set observation changes when a node is added', async () => {
    await writeAspect('obs-bytype', `
      export function check(ctx) {
        ctx.graph.nodesByType('module');
        return [];
      }
    `);
    const before = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r1 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-bytype'),
      aspectId: 'obs-bytype', nodePath: 'N', graph: before, projectRoot,
    });
    const key = observationKey('graph-bytype', 'module');
    const e1 = r1.observations.find(([k]) => k === key);
    expect(e1).toBeDefined();

    // Add a child of N (enters the allowed set as a descendant) of type module.
    const after = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'Dep' }] },
        { path: 'N/extra', type: 'module', mapping: ['src/e.ts'], parent: 'N' },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const r2 = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-bytype'),
      aspectId: 'obs-bytype', nodePath: 'N', graph: after, projectRoot,
    });
    const e2 = r2.observations.find(([k]) => k === key);
    expect(e2).toBeDefined();
    expect(e1![1]).not.toBe(e2![1]); // membership grew → hash changed
  });

  // flowParticipants minor — folds the flow's declared participant set.
  it('ctx.graph.flowParticipants() → graph-flow: participant set observation', async () => {
    await writeAspect('obs-flow', `
      export function check(ctx) {
        ctx.graph.flowParticipants('checkout');
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'N', type: 'module', mapping: ['src/a.ts'] },
        { path: 'Dep', type: 'module', mapping: ['src/b.ts'] },
      ],
      flows: [{ path: 'checkout', nodes: ['N', 'Dep'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-flow'),
      aspectId: 'obs-flow', nodePath: 'N', graph: g, projectRoot,
    });
    const key = observationKey('graph-flow', 'checkout');
    const entry = r.observations.find(([k]) => k === key);
    expect(entry).toBeDefined();
    expect(entry![1]).toBe(hashNodeSetObservation(['N', 'Dep']));
  });

  // Bug 1 — a non-subject sibling reachable via ctx.node.files folds a read:
  // observation when the subject set is narrowed (per: file via subjectScope).
  it('per:file — sibling in ctx.node.files folds a read: observation', async () => {
    // Node maps BOTH src/a.ts and src/b.ts. With subjectScope=[src/a.ts] (a
    // per:file pair for a.ts), src/b.ts is NOT a subject but IS in ctx.node.files
    // with content preloaded — reading its .content must be covered by a read:
    // observation so editing b.ts invalidates a.ts's verdict.
    await writeAspect('obs-sibling', `
      export function check(ctx) {
        // Read a sibling's preloaded content via ctx.node.files (no ctx.fs call).
        const sibling = ctx.node.files.find(f => f.path === 'src/b.ts');
        void sibling.content;
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts', 'src/b.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-sibling'),
      aspectId: 'obs-sibling', nodePath: 'N', graph: g, projectRoot,
      subjectScope: ['src/a.ts'],
    });
    expect(r.succeeded).toBe(true);
    // src/b.ts (non-subject) must be folded as a read: observation.
    const bKey = observationKey('read', 'src/b.ts');
    const bEntry = r.observations.find(([k]) => k === bKey);
    expect(bEntry).toBeDefined();
    expect(bEntry![1]).toBe(hashReadObservation(Buffer.from('export const y = 2;')));
    // src/a.ts (the subject) must NOT be a read: observation.
    const aEntry = r.observations.find(([k]) => k === observationKey('read', 'src/a.ts'));
    expect(aEntry).toBeUndefined();
  });

  // Bug 1 (AST field) — a non-subject sibling's `.ast` is content-derived, so
  // reading it (without ever touching `.content`) must fold the same read:
  // observation. Otherwise editing the sibling changes its AST but the pair
  // stays stale-green.
  it('per:file — sibling .ast access in ctx.node.files folds a read: observation', async () => {
    await writeAspect('obs-sibling-ast', `
      export function check(ctx) {
        // Read a sibling's parsed AST via ctx.node.files (never its .content).
        const sibling = ctx.node.files.find(f => f.path === 'src/b.ts');
        void sibling.ast;
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts', 'src/b.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-sibling-ast'),
      aspectId: 'obs-sibling-ast', nodePath: 'N', graph: g, projectRoot,
      subjectScope: ['src/a.ts'],
    });
    expect(r.succeeded).toBe(true);
    // src/b.ts (non-subject) must be folded as a read: observation on the .ast read.
    const bKey = observationKey('read', 'src/b.ts');
    const bEntry = r.observations.find(([k]) => k === bKey);
    expect(bEntry).toBeDefined();
    expect(bEntry![1]).toBe(hashReadObservation(Buffer.from('export const y = 2;')));
    // src/a.ts (the subject) must NOT be a read: observation.
    const aEntry = r.observations.find(([k]) => k === observationKey('read', 'src/a.ts'));
    expect(aEntry).toBeUndefined();
  });

  it('per:node (no subjectScope) — own mapping files are NOT folded as read: observations', async () => {
    // Without a narrowed subject set, every mapped file is a subject and hashed as
    // a subject input — no duplicate read: observations for own files.
    await writeAspect('obs-no-dup', `
      export function check(ctx) {
        void ctx.node.files.length;
        return [];
      }
    `);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts', 'src/b.ts'] }],
    });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/obs-no-dup'),
      aspectId: 'obs-no-dup', nodePath: 'N', graph: g, projectRoot,
    });
    const reads = r.observations.filter(([k]) => k.startsWith('read:'));
    expect(reads).toHaveLength(0);
  });
});
