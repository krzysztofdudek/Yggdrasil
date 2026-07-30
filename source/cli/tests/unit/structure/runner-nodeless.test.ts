/**
 * The deterministic runner's nodeless unit (`unit.kind === 'file'`): a rule
 * running on a file enforced by its architecture type alone, with no owning
 * component. Real, on-disk check.mjs fixtures (tests/fixtures/type-level-engine
 * merged with its nodeless-runner variant) driven directly through
 * runStructureAspect with a hand-built unit — no pairs/effective-aspect
 * cascade involved, so the allowance (`unit.allowedReads`) is constructed by
 * hand per test rather than through collectArchitectureReach (that function's
 * own contract is pinned separately in allowed-reads.test.ts).
 *
 * HERMETIC: a fresh mkdtemp merge (base fixture + nodeless-runner variant) per
 * test, mutated in place where needed, removed in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import type { StructureUnit } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import { FIXTURE_NODELESS_RUNNER } from '../../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'type-level-engine');

describe('deterministic runner — nodeless unit (unit.kind === "file")', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-nodeless-runner-'));
    cpSync(BASE_FIXTURE, projectRoot, { recursive: true });
    cpSync(FIXTURE_NODELESS_RUNNER, projectRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    cleanupTestGraphs();
  });

  const emptyGraph = () => buildTestGraphForStructure({ nodes: [] });
  const aspectDir = (id: string) => path.join(projectRoot, '.yggdrasil', 'aspects', id);

  function fileUnit(allowedReads: string[], file = 'src/leaf/a.ts', typeId = 'leaf'): StructureUnit {
    return { kind: 'file', file, typeId, allowedReads };
  }

  it('reads-self: passes reading only ctx.subject[0].content, and re-verifies with nothing touched', async () => {
    const r = await runStructureAspect({
      aspectDir: aspectDir('reads-self'),
      aspectId: 'reads-self',
      unit: fileUnit(['src/leaf/a.ts']),
      graph: emptyGraph(),
      projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(0);
    // The subject file itself is handed to the check (touchedFiles mirrors
    // the whole-node case's own subject bookkeeping), but ctx.subject access
    // never goes through ctx.fs, so it folds NO observation — the subject is
    // hashed separately as a subject input, never double-recorded.
    expect(r.touchedFiles).toEqual(['src/leaf/a.ts']);
    expect(r.observations).toHaveLength(0);
  });

  it('reads-permitted-sibling: passes, records the sibling as an observation, and a later edit to it changes that observation', async () => {
    const unit = fileUnit(['src/leaf/a.ts', 'src/helper/h.ts']);
    const r1 = await runStructureAspect({
      aspectDir: aspectDir('reads-permitted-sibling'),
      aspectId: 'reads-permitted-sibling',
      unit,
      graph: emptyGraph(),
      projectRoot,
    });
    expect(r1.succeeded).toBe(true);
    expect(r1.violations).toHaveLength(0);
    expect(r1.touchedFiles).toContain('src/helper/h.ts');
    const key = 'read:src/helper/h.ts';
    const before = r1.observations.find(([k]) => k === key)?.[1];
    expect(before).toBeDefined();

    // Editing the sibling changes what a re-observation of the SAME key would
    // hash to — the fact that makes a stored result need re-checking.
    writeFileSync(path.join(projectRoot, 'src/helper/h.ts'), 'export const h = 2; // edited\n');
    const r2 = await runStructureAspect({
      aspectDir: aspectDir('reads-permitted-sibling'),
      aspectId: 'reads-permitted-sibling',
      unit,
      graph: emptyGraph(),
      projectRoot,
    });
    const after = r2.observations.find(([k]) => k === key)?.[1];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('reads-forbidden: thrown as infrastructure, naming both exits (widen the architecture, or give the file a component)', async () => {
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: aspectDir('reads-forbidden'),
        aspectId: 'reads-forbidden',
        // 'src/forbidden/x.ts' deliberately absent from the allowance.
        unit: fileUnit(['src/leaf/a.ts']),
        graph: emptyGraph(),
        projectRoot,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    const err = caught as StructureRunnerError;
    expect(err.code).toBe('STRUCTURE_UNDECLARED_FS_READ');
    const rendered = err.messageData.what + err.messageData.why + err.messageData.next;
    expect(rendered).toContain('src/forbidden/x.ts');
    expect(rendered).toMatch(/architecture/i);
    expect(rendered).toMatch(/component/i);
  });

  it('touches-node: a typed, fail-closed infra disposition naming both exits (file-local, or give it a component)', async () => {
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: aspectDir('touches-node'),
        aspectId: 'touches-node',
        unit: fileUnit(['src/leaf/a.ts']),
        graph: emptyGraph(),
        projectRoot,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    const err = caught as StructureRunnerError;
    expect(err.code).toBe('STRUCTURE_NODE_CONTEXT_UNAVAILABLE');
    expect(err.messageData.why + err.messageData.next).toMatch(/component/i);
    expect(err.messageData.next).toMatch(/ctx\.subject|ctx\.fs/);
  });

  it('touches-graph: the SAME typed, fail-closed infra disposition as touches-node', async () => {
    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: aspectDir('touches-graph'),
        aspectId: 'touches-graph',
        unit: fileUnit(['src/leaf/a.ts']),
        graph: emptyGraph(),
        projectRoot,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_NODE_CONTEXT_UNAVAILABLE');
  });

  it('lists-dir: passes, and adding an unrelated file to the listed directory changes the list observation', async () => {
    const unit = fileUnit(['src/leaf/a.ts', 'src/helper']);
    const r1 = await runStructureAspect({
      aspectDir: aspectDir('lists-dir'),
      aspectId: 'lists-dir',
      unit,
      graph: emptyGraph(),
      projectRoot,
    });
    expect(r1.succeeded).toBe(true);
    expect(r1.violations).toHaveLength(0);
    const key = 'list:src/helper';
    const before = r1.observations.find(([k]) => k === key)?.[1];
    expect(before).toBeDefined();

    // Add a file the check never itself reads — the RAW listing still folds
    // its name, so the observation changes regardless (pins the raw-listing
    // decision: over-observation, never under-observation).
    writeFileSync(path.join(projectRoot, 'src/helper/unrelated.ts'), 'export const u = 1;\n');
    const r2 = await runStructureAspect({
      aspectDir: aspectDir('lists-dir'),
      aspectId: 'lists-dir',
      unit,
      graph: emptyGraph(),
      projectRoot,
    });
    const after = r2.observations.find(([k]) => k === key)?.[1];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('a nodeless unit is deterministic: two runs over unchanged inputs return identical violations and observations', async () => {
    const unit = fileUnit(['src/leaf/a.ts', 'src/helper/h.ts']);
    const run = () =>
      runStructureAspect({
        aspectDir: aspectDir('reads-permitted-sibling'),
        aspectId: 'reads-permitted-sibling',
        unit,
        graph: emptyGraph(),
        projectRoot,
      });
    const r1 = await run();
    const r2 = await run();
    expect(r2.violations).toEqual(r1.violations);
    expect(r2.observations).toEqual(r1.observations);
    expect(r2.succeeded).toBe(r1.succeeded);
  });

  // K6: the SAME rule (reads-permitted-sibling) run for two subject files whose
  // reach differs because their MATCHED TYPE differs — reach is a property of
  // the file's type, not of the rule. A permissive type's file passes; a
  // restrictive type's file (whose allowance omits the sibling) fails as
  // infrastructure — asserted together so the asymmetry is visible in one place.
  it('K6 — the same rule has different reach on two files, because reach comes from each file\'s type', async () => {
    writeFileSync(path.join(projectRoot, 'src/leaf/other.ts'), 'export const other = 1;\n');

    const permissive = await runStructureAspect({
      aspectDir: aspectDir('reads-permitted-sibling'),
      aspectId: 'reads-permitted-sibling',
      // fromType 'leaf': the architecture (this test's own allowance) permits
      // reaching the helper.
      unit: fileUnit(['src/leaf/a.ts', 'src/helper/h.ts'], 'src/leaf/a.ts', 'leaf'),
      graph: emptyGraph(),
      projectRoot,
    });
    expect(permissive.succeeded).toBe(true);
    expect(permissive.violations).toHaveLength(0);

    let caught: unknown;
    try {
      await runStructureAspect({
        aspectDir: aspectDir('reads-permitted-sibling'),
        aspectId: 'reads-permitted-sibling',
        // fromType 'restricted-leaf': same rule, same check.mjs — but this
        // file's type is not permitted to reach the helper, so its own
        // allowance never includes it.
        unit: fileUnit(['src/leaf/other.ts'], 'src/leaf/other.ts', 'restricted-leaf'),
        graph: emptyGraph(),
        projectRoot,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructureRunnerError);
    expect((caught as StructureRunnerError).code).toBe('STRUCTURE_UNDECLARED_FS_READ');
  });
});
