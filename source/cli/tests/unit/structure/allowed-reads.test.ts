import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAllowedReadsForAspect, collectArchitectureReach } from '../../../src/structure/allowed-reads.js';
import type { ArchitectureReachInput } from '../../../src/structure/allowed-reads.js';
import { buildOwnerIndex } from '../../../src/relations/owner-index.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { ArchitectureDef, Graph } from '../../../src/model/graph.js';

/** Write a real on-disk file under a graph's project root — collectArchitectureReach
 * now expands declared-component mappings via the filesystem (expandMappingPaths),
 * so a component's mapped files must genuinely exist for it to contribute anything. */
function writeRealFile(graph: Graph, relPath: string, content = ''): void {
  const abs = path.join(path.dirname(graph.rootPath), relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * CRITICAL privileged-runtime guard (mirrors tests/e2e/cli-scope-unreadable.test.ts):
 * under root (CI / container) chmod 0o000 is ignored and readFileSync still
 * succeeds, so a test relying on EACCES would either fail for the wrong reason
 * or silently run zero real assertions. Probed once at module load; the
 * affected test is skipped via `it.skipIf` in that environment.
 */
function probeEnforcesFilePermissions(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-permcheck-'));
  const probe = path.join(dir, 'probe.txt');
  writeFileSync(probe, 'x');
  chmodSync(probe, 0o000);
  let enforced = false;
  try {
    readFileSync(probe, 'utf8');
  } catch {
    enforced = true;
  }
  chmodSync(probe, 0o644); // restore so rmSync can remove it
  rmSync(dir, { recursive: true, force: true });
  return enforced;
}
const ENFORCES_FILE_PERMISSIONS = probeEnforcesFilePermissions();

describe('collectAllowedReadsForAspect', () => {
  afterEach(() => cleanupTestGraphs());

  it('own mapping minus child mapping (child wins)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'parent', type: 'module', mapping: ['src/parent', 'src/parent/foo.ts'] },
        { path: 'parent/child', type: 'module', mapping: ['src/parent/child.ts'], parent: 'parent' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('parent', g);
    expect(allowed.has('src/parent/foo.ts')).toBe(true);
    expect(allowed.has('src/parent/child.ts')).toBe(false);
  });

  it('declared relation target mapping included', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'module', mapping: ['src/a.ts'],
          relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const allowed = collectAllowedReadsForAspect('A', g);
    expect(allowed.has('src/b.ts')).toBe(true);
  });

  it('consumed port owner mapping included (subsumed by target mapping)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'consumer', type: 'module', mapping: ['src/consumer.ts'],
          relations: [{ type: 'calls', target: 'provider', consumes: ['api'] }] },
        { path: 'provider', type: 'module', mapping: ['src/provider.ts'],
          ports: { api: { description: '', aspects: [] } } },
      ],
    });
    const allowed = collectAllowedReadsForAspect('consumer', g);
    expect(allowed.has('src/provider.ts')).toBe(true);
  });

  it('ancestor mapping included', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root.ts'] },
        { path: 'root/child', type: 'module', mapping: ['src/child.ts'], parent: 'root' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root/child', g);
    expect(allowed.has('src/root.ts')).toBe(true);
  });

  it('descendant mapping included', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root'] },
        { path: 'root/leaf', type: 'module', mapping: ['src/root/leaf.ts'], parent: 'root' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root', g);
    expect(allowed.has('src/root/leaf.ts')).toBe(true);
  });

  it('returns empty set for missing node id', () => {
    const g = buildTestGraphForStructure({ nodes: [] });
    expect(collectAllowedReadsForAspect('ghost', g).size).toBe(0);
  });

  it('relation target descendants are transitively included (dogfood prerequisite)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'command', type: 'module', mapping: ['src/cmd.ts'],
          relations: [{ type: 'uses', target: 'tests/suite' }] },
        { path: 'tests/suite', type: 'module', mapping: [] },
        { path: 'tests/suite/group-a', type: 'module', mapping: ['tests/a.test.ts'], parent: 'tests/suite' },
        { path: 'tests/suite/group-b', type: 'module', mapping: ['tests/b.test.ts'], parent: 'tests/suite' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('command', g);
    expect(allowed.has('tests/a.test.ts')).toBe(true);
    expect(allowed.has('tests/b.test.ts')).toBe(true);
  });
});

// =============================================================================
// collectArchitectureReach — the allowance for a rule on a file with no
// component of its own (Task 7). The architecture's relation allow-list is the
// ONLY authority: 'leaf' may `uses` a component typed 'owned-type' or a
// type-covered file typed 'helper-type', but every other relation type
// defaults to deny, so a file typed 'forbidden-type' is out of reach.
// =============================================================================

describe('what a rule running on a single file may read', () => {
  const ARCHITECTURE: ArchitectureDef = {
    node_types: {
      leaf: {
        description: 'A file classified by its own type, no component.',
        relationDefault: 'deny',
        relations: { uses: ['owned-type', 'helper-type'] },
      },
      'owned-type': { description: 'A declared component the architecture permits leaf to depend on.' },
      'helper-type': { description: 'A type-covered file the architecture permits leaf to depend on.' },
      'forbidden-type': { description: 'A declared component leaf is NOT permitted to depend on.' },
    },
  };

  function buildInput(): ArchitectureReachInput {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'owned', type: 'owned-type', mapping: ['src/owned/o.ts'] },
        { path: 'forbidden', type: 'forbidden-type', mapping: ['src/forbidden/f.ts'] },
      ],
    });
    g.architecture = ARCHITECTURE;
    writeRealFile(g, 'src/owned/o.ts', 'export const o = 1;\n');
    writeRealFile(g, 'src/forbidden/f.ts', 'export const f = 1;\n');
    return {
      fromType: 'leaf',
      typeCovered: new Map([
        ['src/leaf/a.ts', 'leaf'],
        ['src/helper/h.ts', 'helper-type'],
      ]),
      architecture: ARCHITECTURE,
      graph: g,
      projectRoot: path.dirname(g.rootPath),
      ownerIndex: buildOwnerIndex(g.nodes),
    };
  }

  afterEach(() => cleanupTestGraphs());

  it('always includes the file itself', async () => {
    const reach = await collectArchitectureReach('src/leaf/a.ts', buildInput());
    expect(reach.has('src/leaf/a.ts')).toBe(true);
  });

  it('includes files of a type the architecture permits this type to depend on', async () => {
    // The architecture says leaf may use helper-type, so a rule on a leaf file
    // may read helper-type files — whether or not those helpers have a component.
    const reach = await collectArchitectureReach('src/leaf/a.ts', buildInput());
    expect(reach.has('src/helper/h.ts')).toBe(true); // enforced by its type alone
    expect(reach.has('src/owned/o.ts')).toBe(true);  // belongs to a declared component
  });

  it('excludes files of a type the architecture forbids', async () => {
    const reach = await collectArchitectureReach('src/leaf/a.ts', buildInput());
    expect(reach.has('src/forbidden/f.ts')).toBe(false);
  });

  it('reaches nothing but the subject when the type is not in the architecture', async () => {
    const reach = await collectArchitectureReach('src/leaf/a.ts', { ...buildInput(), fromType: 'ghost' });
    expect([...reach]).toEqual(['src/leaf/a.ts']);
  });

  it('cache-by-fromType is safe across different subject files of the same type (no cross-file leakage)', async () => {
    // Two files share type 'leaf'. Computing reach for one first must not make
    // the OTHER file's own reach miss its own self-inclusion, and must not gain
    // the first file's identity as a side effect (K9's caching note: a caller
    // memoizing this by fromType alone must still union the subject in fresh
    // per file — this test pins that the function's own OUTPUT is correct
    // whichever file is asked about, independent of any caller-side cache).
    const input = buildInput();
    input.typeCovered.set('src/leaf/b.ts', 'leaf');
    const reachA = await collectArchitectureReach('src/leaf/a.ts', input);
    const reachB = await collectArchitectureReach('src/leaf/b.ts', input);
    expect(reachA.has('src/leaf/a.ts')).toBe(true);
    expect(reachB.has('src/leaf/b.ts')).toBe(true);
    // leaf -> leaf has no permitted relation type in this architecture (only
    // uses -> owned-type/helper-type is listed), so neither file reaches the
    // OTHER purely by virtue of sharing a type — each reaches itself only via
    // the unconditional subject-file clause.
    expect(reachA.has('src/leaf/b.ts')).toBe(false);
    expect(reachB.has('src/leaf/a.ts')).toBe(false);
  });

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)(
    "excludes a declared component's mapped file the gate itself could never read (mirrors relations/pass.ts's own \"unreadable → skip\")",
    async () => {
      const ARCH: ArchitectureDef = {
        node_types: {
          leaf: { description: 'A file classified by its own type, no component.', relationDefault: 'deny', relations: { uses: ['owned-type'] } },
          'owned-type': { description: 'A component whose directory mapping includes a file this allowance cannot read.' },
        },
      };
      const g = buildTestGraphForStructure({
        nodes: [{ path: 'owned', type: 'owned-type', mapping: ['src/owned'] }],
      });
      g.architecture = ARCH;
      writeRealFile(g, 'src/owned/readable.ts', 'export const r = 1;\n');
      writeRealFile(g, 'src/owned/locked.ts', 'export const l = 1;\n');
      const lockedAbs = path.join(path.dirname(g.rootPath), 'src/owned/locked.ts');
      chmodSync(lockedAbs, 0o000);
      try {
        const reach = await collectArchitectureReach('src/leaf/a.ts', {
          fromType: 'leaf',
          typeCovered: new Map(),
          architecture: ARCH,
          graph: g,
          projectRoot: path.dirname(g.rootPath),
          ownerIndex: buildOwnerIndex(g.nodes),
        });
        // The readable sibling in the SAME directory mapping stays reachable —
        // the readability check must exclude only the file it applies to,
        // never the whole owning component.
        expect(reach.has('src/owned/readable.ts')).toBe(true);
        // relations/pass.ts (the live dependency gate) skips a mapped file it
        // cannot read BEFORE that file ever earns an owner-type entry in
        // fileOwnerType — the gate treats it as though it does not exist. This
        // allowance must treat it the same way: an actual ctx.fs.read would
        // fail regardless, but admitting the path into the permission set
        // anyway is a needless divergence from the one authority (child-wins
        // ownership + the architecture's relations:) this allowance exists to
        // mirror.
        expect(reach.has('src/owned/locked.ts')).toBe(false);
      } finally {
        chmodSync(lockedAbs, 0o644); // restore so cleanupTestGraphs can remove the tree
      }
    },
  );
});

// =============================================================================
// Ownership resolution must match the live type gate's child-wins authority —
// a raw mapping-entry prefix match is NOT good enough. Reproduces the
// reviewer's exact shape: a permitted-type component maps a whole DIRECTORY,
// and a forbidden-type CHILD component maps one specific FILE inside it.
// =============================================================================

describe('child-wins ownership resolution for a directory mapping', () => {
  const ARCHITECTURE: ArchitectureDef = {
    node_types: {
      leaf: {
        description: 'A file classified by its own type, no component.',
        relationDefault: 'deny',
        relations: { uses: ['parent-type'] },
      },
      'parent-type': { description: 'A component whose mapping is a whole directory.' },
      'child-type': { description: 'A component nested under a parent-type node, owning one specific file inside the directory the parent maps. leaf may NOT depend on this type.' },
    },
  };

  afterEach(() => cleanupTestGraphs());

  it("excludes a forbidden child component's file even though a permitted parent's directory mapping textually covers it", async () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'parent', type: 'parent-type', mapping: ['src/parent'] },
        { path: 'parent/child', type: 'child-type', parent: 'parent', mapping: ['src/parent/child.ts'] },
      ],
    });
    g.architecture = ARCHITECTURE;
    writeRealFile(g, 'src/parent/foo.ts', 'export const foo = 1;\n');
    writeRealFile(g, 'src/parent/child.ts', 'export const child = 1;\n');

    const reach = await collectArchitectureReach('src/leaf/a.ts', {
      fromType: 'leaf',
      typeCovered: new Map(),
      architecture: ARCHITECTURE,
      graph: g,
      projectRoot: path.dirname(g.rootPath),
      ownerIndex: buildOwnerIndex(g.nodes),
    });

    // The parent's OWN file — leaf may depend on parent-type — is reachable.
    // (A stale implementation that never expands the directory at all would
    // fail THIS assertion: the raw mapping entry 'src/parent' is a literal
    // directory string, never equal to the real file path.)
    expect(reach.has('src/parent/foo.ts')).toBe(true);
    // The child's file belongs to child-type (leaf may NOT depend on it). The
    // parent's directory mapping textually covers it, but ownership
    // (child-wins — the SAME resolution the live type gate's fileOwnerType
    // uses) reassigns it to the child, so it must stay out of reach even
    // though it sits inside a directory a PERMITTED type maps.
    expect(reach.has('src/parent/child.ts')).toBe(false);
  });
});
