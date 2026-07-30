import { describe, it, expect, afterEach } from 'vitest';
import { collectAllowedReadsForAspect, collectArchitectureReach } from '../../../src/structure/allowed-reads.js';
import type { ArchitectureReachInput } from '../../../src/structure/allowed-reads.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { ArchitectureDef } from '../../../src/model/graph.js';

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
    return {
      fromType: 'leaf',
      typeCovered: new Map([
        ['src/leaf/a.ts', 'leaf'],
        ['src/helper/h.ts', 'helper-type'],
      ]),
      architecture: ARCHITECTURE,
      graph: g,
    };
  }

  afterEach(() => cleanupTestGraphs());

  it('always includes the file itself', () => {
    const reach = collectArchitectureReach('src/leaf/a.ts', buildInput());
    expect(reach.has('src/leaf/a.ts')).toBe(true);
  });

  it('includes files of a type the architecture permits this type to depend on', () => {
    // The architecture says leaf may use helper-type, so a rule on a leaf file
    // may read helper-type files — whether or not those helpers have a component.
    const reach = collectArchitectureReach('src/leaf/a.ts', buildInput());
    expect(reach.has('src/helper/h.ts')).toBe(true); // enforced by its type alone
    expect(reach.has('src/owned/o.ts')).toBe(true);  // belongs to a declared component
  });

  it('excludes files of a type the architecture forbids', () => {
    const reach = collectArchitectureReach('src/leaf/a.ts', buildInput());
    expect(reach.has('src/forbidden/f.ts')).toBe(false);
  });

  it('reaches nothing but the subject when the type is not in the architecture', () => {
    const reach = collectArchitectureReach('src/leaf/a.ts', { ...buildInput(), fromType: 'ghost' });
    expect([...reach]).toEqual(['src/leaf/a.ts']);
  });

  it('cache-by-fromType is safe across different subject files of the same type (no cross-file leakage)', () => {
    // Two files share type 'leaf'. Computing reach for one first must not make
    // the OTHER file's own reach miss its own self-inclusion, and must not gain
    // the first file's identity as a side effect (K9's caching note: a caller
    // memoizing this by fromType alone must still union the subject in fresh
    // per file — this test pins that the function's own OUTPUT is correct
    // whichever file is asked about, independent of any caller-side cache).
    const input = buildInput();
    input.typeCovered.set('src/leaf/b.ts', 'leaf');
    const reachA = collectArchitectureReach('src/leaf/a.ts', input);
    const reachB = collectArchitectureReach('src/leaf/b.ts', input);
    expect(reachA.has('src/leaf/a.ts')).toBe(true);
    expect(reachB.has('src/leaf/b.ts')).toBe(true);
    // leaf -> leaf has no permitted relation type in this architecture (only
    // uses -> owned-type/helper-type is listed), so neither file reaches the
    // OTHER purely by virtue of sharing a type — each reaches itself only via
    // the unconditional subject-file clause.
    expect(reachA.has('src/leaf/b.ts')).toBe(false);
    expect(reachB.has('src/leaf/a.ts')).toBe(false);
  });
});
