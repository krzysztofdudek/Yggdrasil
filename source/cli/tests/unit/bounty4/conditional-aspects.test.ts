import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWhen } from '../../../src/utils/when-parser.js';
import { parseFileWhen, WhenPredicateInvalidError } from '../../../src/utils/file-when-parser.js';
import { evaluateWhen } from '../../../src/core/when-evaluator.js';
import { evaluateFileWhen } from '../../../src/core/file-when-evaluator.js';
import { computeEffectiveAspects } from '../../../src/core/graph/aspects.js';
import { checkWhenReferences } from '../../../src/core/checks/aspects.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

// ---------------------------------------------------------------------------
// SPEC = `yg knowledge read conditional-aspects`
//
// Conformance audit: assert the IMPLEMENTING CODE actually does what the doc
// promises. Two grammars (aspect-when vs file-when), the boolean combinators,
// each documented atom, the structural parser rules, reference-integrity
// errors, and the global+attach AND combination.
// ---------------------------------------------------------------------------

function mkNode(path: string, meta: Partial<GraphNode['meta']> = {}): GraphNode {
  return {
    path,
    meta: { name: path, type: 'service', ...meta },
    children: [],
    parent: null,
  } as GraphNode;
}

function mkGraph(nodes: GraphNode[], overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: { service: { description: 's' }, command: { description: 'c' } } },
    nodes: new Map(nodes.map((n) => [n.path, n])),
    aspects: [],
    flows: [],
    rootPath: '/tmp',
    ...overrides,
  } as unknown as Graph;
}

function link(parent: GraphNode, child: GraphNode): void {
  child.parent = parent;
  parent.children.push(child);
}

// =====================================================================
// SECTION A — Two distinct grammars share operators, NOT atoms
// SPEC: "Never use an atom from one grammar in the other."
// aspect-when atoms: node / relations / descendants
// file-when atoms:   path / content
// =====================================================================
describe('A. two grammars: operators shared, atoms disjoint', () => {
  it('aspect-when rejects file-when atoms (path, content)', () => {
    expect(() => parseWhen({ path: 'src/**' }, 'ctx')).toThrow(/unknown when operator 'path'/);
    expect(() => parseWhen({ content: 'export' }, 'ctx')).toThrow(/unknown when operator 'content'/);
  });

  it('file-when rejects aspect-when atoms (node, relations, descendants)', () => {
    expect(() => parseFileWhen({ node: { type: 'x' } }, 'ctx', 'scope.files')).toThrow(/unknown when key 'node'/);
    expect(() => parseFileWhen({ relations: { calls: { target: 'a' } } }, 'ctx', 'scope.files')).toThrow(
      /unknown when key 'relations'/,
    );
    expect(() => parseFileWhen({ descendants: { type: 'x' } }, 'ctx', 'scope.files')).toThrow(
      /unknown when key 'descendants'/,
    );
  });

  it('both grammars accept the same three boolean operator names', () => {
    expect(parseWhen({ all_of: [{ node: { type: 'x' } }] }, 'ctx')).toHaveProperty('all_of');
    expect(parseWhen({ any_of: [{ node: { type: 'x' } }] }, 'ctx')).toHaveProperty('any_of');
    expect(parseWhen({ not: { node: { type: 'x' } } }, 'ctx')).toHaveProperty('not');
    expect(parseFileWhen({ all_of: [{ path: 'a' }] }, 'ctx', 'scope.files')).toHaveProperty('all_of');
    expect(parseFileWhen({ any_of: [{ path: 'a' }] }, 'ctx', 'scope.files')).toHaveProperty('any_of');
    expect(parseFileWhen({ not: { path: 'a' } }, 'ctx', 'scope.files')).toHaveProperty('not');
  });

  it('file-when parser failures carry the when-predicate-invalid code', () => {
    try {
      parseFileWhen({ node: { type: 'x' } }, 'ctx', 'scope.files');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WhenPredicateInvalidError);
      expect((e as WhenPredicateInvalidError).code).toBe('when-predicate-invalid');
    }
  });
});

// =====================================================================
// SECTION B — Structural parser rules (aspect-when)
// SPEC "Rules the parser enforces":
//  - relation-type entry must carry a match; relations:{emits:{}} rejected
//  - node/relations/descendants clause must carry >=1 inner field
//  - one level: EITHER one boolean operator OR atomic clauses, not both;
//    at most one boolean operator
// =====================================================================
describe('B. aspect-when structural parser rules', () => {
  it('rejects a relation-type entry with no match (relations: { emits: {} })', () => {
    expect(() => parseWhen({ relations: { emits: {} } }, 'ctx')).toThrow(
      /at least one of target_type, target, consumes_port/,
    );
  });

  it('rejects an empty node clause', () => {
    expect(() => parseWhen({ node: {} }, 'ctx')).toThrow(
      /at least one of type, has_port, has_mapping/,
    );
  });

  it('rejects an empty descendants clause', () => {
    expect(() => parseWhen({ descendants: {} }, 'ctx')).toThrow(
      /at least one of relations, type, has_port/,
    );
  });

  it('rejects an empty relations mapping', () => {
    expect(() => parseWhen({ relations: {} }, 'ctx')).toThrow(/relations mapping must not be empty/);
  });

  it('rejects mixing a boolean operator with atomic clauses at one level', () => {
    expect(() => parseWhen({ all_of: [{ node: { type: 'x' } }], node: { type: 'y' } }, 'ctx')).toThrow(
      /cannot mix boolean operators with atomic clauses/,
    );
  });

  it('rejects more than one boolean operator at one level', () => {
    expect(() =>
      parseWhen({ all_of: [{ node: { type: 'x' } }], any_of: [{ node: { type: 'y' } }] }, 'ctx'),
    ).toThrow(/at most one boolean operator/);
  });

  it('rejects an empty when mapping', () => {
    expect(() => parseWhen({}, 'ctx')).toThrow(/when mapping must not be empty/);
  });

  it('rejects unknown relation types (only the six are valid)', () => {
    expect(() => parseWhen({ relations: { invokes: { target: 'a' } } }, 'ctx')).toThrow(
      /unknown relation type 'invokes'/,
    );
  });

  it('accepts all six documented relation types', () => {
    for (const t of ['calls', 'uses', 'extends', 'implements', 'emits', 'listens']) {
      const parsed = parseWhen({ relations: { [t]: { target: 'a' } } }, 'ctx') as { relations: Record<string, unknown> };
      expect(parsed.relations[t]).toBeDefined();
    }
  });

  it('rejects empty boolean arrays (all_of: [], any_of: [])', () => {
    expect(() => parseWhen({ all_of: [] }, 'ctx')).toThrow(/'all_of' array must not be empty/);
    expect(() => parseWhen({ any_of: [] }, 'ctx')).toThrow(/'any_of' array must not be empty/);
  });

  it('multiple atoms at top level imply all_of (implicit AND)', () => {
    // SPEC: "multiple atoms at the top level imply all_of"
    const parsed = parseWhen({ node: { type: 'command' }, relations: { calls: { target: 'a' } } }, 'ctx');
    expect('all_of' in parsed).toBe(false); // stored as an AtomicClause, not wrapped
    expect((parsed as { node?: unknown; relations?: unknown }).node).toBeDefined();
    expect((parsed as { node?: unknown; relations?: unknown }).relations).toBeDefined();
  });
});

// =====================================================================
// SECTION C — aspect-when atom SEMANTICS (evaluator)
// =====================================================================
describe('C. aspect-when atom semantics', () => {
  it('node.type — exact type match', () => {
    const n = mkNode('x', { type: 'command' });
    const g = mkGraph([n]);
    expect(evaluateWhen({ node: { type: 'command' } }, n, g)).toBe(true);
    expect(evaluateWhen({ node: { type: 'service' } }, n, g)).toBe(false);
  });

  it('node.has_port — node declares the named port', () => {
    const n = mkNode('x', { type: 'service', ports: { charge: { description: 'c', aspects: [] } } });
    const g = mkGraph([n]);
    expect(evaluateWhen({ node: { has_port: 'charge' } }, n, g)).toBe(true);
    expect(evaluateWhen({ node: { has_port: 'refund' } }, n, g)).toBe(false);
  });

  it('node.has_mapping — owns at least one mapped file (true) or owns none (false)', () => {
    const mapped = mkNode('m', { type: 'service', mapping: ['src/x.ts'] });
    const unmapped = mkNode('u', { type: 'service' });
    const emptyMap = mkNode('e', { type: 'service', mapping: [] });
    const g = mkGraph([mapped, unmapped, emptyMap]);
    expect(evaluateWhen({ node: { has_mapping: true } }, mapped, g)).toBe(true);
    expect(evaluateWhen({ node: { has_mapping: false } }, mapped, g)).toBe(false);
    expect(evaluateWhen({ node: { has_mapping: true } }, unmapped, g)).toBe(false);
    expect(evaluateWhen({ node: { has_mapping: false } }, unmapped, g)).toBe(true);
    // empty mapping array owns no files => has_mapping is false
    expect(evaluateWhen({ node: { has_mapping: true } }, emptyMap, g)).toBe(false);
    expect(evaluateWhen({ node: { has_mapping: false } }, emptyMap, g)).toBe(true);
  });

  it('relations.<type>.target_type — at least one relation of that type targets a node of this type', () => {
    const tgt = mkNode('payments', { type: 'service-client' });
    const n = mkNode('orders', { type: 'command', relations: [{ target: 'payments', type: 'calls' }] });
    const g = mkGraph([tgt, n]);
    expect(evaluateWhen({ relations: { calls: { target_type: 'service-client' } } }, n, g)).toBe(true);
    expect(evaluateWhen({ relations: { calls: { target_type: 'repository' } } }, n, g)).toBe(false);
    // wrong relation type does not satisfy
    expect(evaluateWhen({ relations: { uses: { target_type: 'service-client' } } }, n, g)).toBe(false);
  });

  it('relations.<type>.target — targets exactly this node path', () => {
    const n = mkNode('orders', {
      type: 'command',
      relations: [{ target: 'payments/service', type: 'calls' }],
    });
    const g = mkGraph([n, mkNode('payments/service', { type: 'service' })]);
    expect(evaluateWhen({ relations: { calls: { target: 'payments/service' } } }, n, g)).toBe(true);
    expect(evaluateWhen({ relations: { calls: { target: 'payments/other' } } }, n, g)).toBe(false);
  });

  it('relations.<type>.consumes_port — consumes this port on the relation', () => {
    const tgt = mkNode('payments', { type: 'service', ports: { charge: { description: 'c', aspects: [] } } });
    const n = mkNode('orders', {
      type: 'command',
      relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
    });
    const g = mkGraph([tgt, n]);
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'charge' } } }, n, g)).toBe(true);
    expect(evaluateWhen({ relations: { calls: { consumes_port: 'refund' } } }, n, g)).toBe(false);
  });

  it('relation match is existential — one matching relation among many suffices', () => {
    // SPEC: "at least one relation of that type satisfies the match"
    const a = mkNode('a', { type: 'svc' });
    const b = mkNode('b', { type: 'other' });
    const n = mkNode('n', {
      type: 'command',
      relations: [
        { target: 'b', type: 'calls' },
        { target: 'a', type: 'calls' },
      ],
    });
    const g = mkGraph([a, b, n]);
    expect(evaluateWhen({ relations: { calls: { target_type: 'svc' } } }, n, g)).toBe(true);
  });

  it('within one relation match, all sub-keys must hold on the SAME relation', () => {
    // No relation simultaneously is a `calls` to `a` with target_type svc.
    const a = mkNode('a', { type: 'svc' });
    const b = mkNode('b', { type: 'other' });
    const n = mkNode('n', {
      type: 'command',
      relations: [
        { target: 'b', type: 'calls' }, // right type, wrong target_type
        { target: 'a', type: 'uses' }, // right target+type, wrong relation type
      ],
    });
    const g = mkGraph([a, b, n]);
    expect(evaluateWhen({ relations: { calls: { target: 'a', target_type: 'svc' } } }, n, g)).toBe(false);
  });

  it('multiple relation-type keys combine via AND', () => {
    const a = mkNode('a', { type: 'svc' });
    const n = mkNode('n', { type: 'command', relations: [{ target: 'a', type: 'calls' }] });
    const g = mkGraph([a, n]);
    // only `calls` present; requiring both calls AND uses => false
    expect(evaluateWhen({ relations: { calls: { target: 'a' }, uses: { target: 'a' } } }, n, g)).toBe(false);
    expect(evaluateWhen({ relations: { calls: { target: 'a' } } }, n, g)).toBe(true);
  });

  it('descendants.* — satisfied by ANY descendant, never by the node itself', () => {
    const child = mkNode('orders/cmd', { type: 'command' });
    const parent = mkNode('orders', { type: 'module' });
    link(parent, child);
    const g = mkGraph([parent, child]);
    expect(evaluateWhen({ descendants: { type: 'command' } }, parent, g)).toBe(true);
    expect(evaluateWhen({ descendants: { type: 'handler' } }, parent, g)).toBe(false);
    // a leaf node has no descendants => any descendants clause is false
    const leaf = mkNode('leaf', { type: 'command' });
    expect(evaluateWhen({ descendants: { type: 'command' } }, leaf, mkGraph([leaf]))).toBe(false);
  });

  it('descendants.has_port and descendants.relations', () => {
    const child = mkNode('orders/api', {
      type: 'service',
      ports: { charge: { description: 'c', aspects: [] } },
      relations: [{ target: 'pay', type: 'calls' }],
    });
    const target = mkNode('pay', { type: 'service-client' });
    const parent = mkNode('orders', { type: 'module' });
    link(parent, child);
    const g = mkGraph([parent, child, target]);
    expect(evaluateWhen({ descendants: { has_port: 'charge' } }, parent, g)).toBe(true);
    expect(
      evaluateWhen({ descendants: { relations: { calls: { target_type: 'service-client' } } } }, parent, g),
    ).toBe(true);
  });
});

// =====================================================================
// SECTION D — boolean combinators (aspect-when evaluator)
// =====================================================================
describe('D. aspect-when boolean combinators', () => {
  it('all_of — AND (every clause must pass)', () => {
    const n = mkNode('x', { type: 'command' });
    const g = mkGraph([n]);
    expect(evaluateWhen({ all_of: [{ node: { type: 'command' } }, { node: { has_mapping: false } }] }, n, g)).toBe(true);
    expect(evaluateWhen({ all_of: [{ node: { type: 'command' } }, { node: { has_mapping: true } }] }, n, g)).toBe(false);
  });

  it('any_of — OR (at least one clause passes)', () => {
    const n = mkNode('x', { type: 'service' });
    const g = mkGraph([n]);
    expect(evaluateWhen({ any_of: [{ node: { type: 'command' } }, { node: { type: 'service' } }] }, n, g)).toBe(true);
    expect(evaluateWhen({ any_of: [{ node: { type: 'command' } }, { node: { type: 'handler' } }] }, n, g)).toBe(false);
  });

  it('not — negation of a single clause', () => {
    const n = mkNode('x', { type: 'command' });
    const g = mkGraph([n]);
    expect(evaluateWhen({ not: { node: { type: 'service' } } }, n, g)).toBe(true);
    expect(evaluateWhen({ not: { node: { type: 'command' } } }, n, g)).toBe(false);
  });

  it('canonical example: command that owns files but is not a generated stub', () => {
    // SPEC example: all_of: [node{command, has_mapping}, not node{has_port generated}]
    const pred: WhenPredicate = {
      all_of: [{ node: { type: 'command', has_mapping: true } }, { not: { node: { has_port: 'generated' } } }],
    };
    const owns = mkNode('cmd', { type: 'command', mapping: ['src/cmd.ts'] });
    const stub = mkNode('stub', { type: 'command', mapping: ['src/stub.ts'], ports: { generated: { description: 'g', aspects: [] } } });
    const empty = mkNode('empty', { type: 'command' });
    const g = mkGraph([owns, stub, empty]);
    expect(evaluateWhen(pred, owns, g)).toBe(true);
    expect(evaluateWhen(pred, stub, g)).toBe(false); // has the generated port
    expect(evaluateWhen(pred, empty, g)).toBe(false); // no mapping
  });

  it('canonical example: node OR any descendant calls a service-client (any_of)', () => {
    const pred: WhenPredicate = {
      any_of: [
        { relations: { calls: { target_type: 'service-client' } } },
        { descendants: { relations: { calls: { target_type: 'service-client' } } } },
      ],
    };
    const sc = mkNode('sc', { type: 'service-client' });
    // node calls directly
    const direct = mkNode('direct', { type: 'command', relations: [{ target: 'sc', type: 'calls' }] });
    expect(evaluateWhen(pred, direct, mkGraph([sc, direct]))).toBe(true);
    // only a descendant calls
    const parent = mkNode('parent', { type: 'module' });
    const child = mkNode('parent/h', { type: 'handler', relations: [{ target: 'sc', type: 'calls' }] });
    link(parent, child);
    expect(evaluateWhen(pred, parent, mkGraph([sc, parent, child]))).toBe(true);
    // neither
    const none = mkNode('none', { type: 'command' });
    expect(evaluateWhen(pred, none, mkGraph([sc, none]))).toBe(false);
  });
});

// =====================================================================
// SECTION E — file-when grammar (architecture file classification only)
// SPEC: only atoms are path (minimatch glob, repo-relative POSIX) and
// content (JS regex against file content). path+content top level => all_of.
// =====================================================================
describe('E. file-when classification grammar', () => {
  let tmpDir: string;
  let cache: FileContentCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cawb4-'));
    cache = new FileContentCache();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function ctx(filePath: string) {
    return { absPath: join(tmpDir, filePath), repoRelPath: filePath, projectRoot: tmpDir, cache };
  }

  it('path atom — minimatch glob on repo-relative POSIX path; * does not cross /, ** does', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    // `*` stays within one segment
    expect((await evaluateFileWhen({ path: 'src/*.ts' }, ctx('src/a.ts'))).result).toBe(true);
    expect((await evaluateFileWhen({ path: 'src/*.ts' }, ctx('src/deep/a.ts'))).result).toBe(false);
    // `**` crosses segments
    expect((await evaluateFileWhen({ path: 'src/**/*.ts' }, ctx('src/deep/a.ts'))).result).toBe(true);
  });

  it('content atom — JavaScript regex tested against file content', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export class Widget {}');
    expect((await evaluateFileWhen({ content: 'export class' }, ctx('a.ts'))).result).toBe(true);
    expect((await evaluateFileWhen({ content: 'export interface' }, ctx('a.ts'))).result).toBe(false);
  });

  it('top-level path + content implies all_of', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export class Widget {}');
    const r = await evaluateFileWhen({ path: '*.ts', content: 'export class' }, ctx('a.ts'));
    expect(r.result).toBe(true);
    expect(r.trace.kind).toBe('all_of');
    // fails if either atom fails
    expect((await evaluateFileWhen({ path: '*.py', content: 'export class' }, ctx('a.ts'))).result).toBe(false);
    expect((await evaluateFileWhen({ path: '*.ts', content: 'NOPE' }, ctx('a.ts'))).result).toBe(false);
  });

  it('boolean combinators behave the same (all_of/any_of/not)', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'foo');
    expect((await evaluateFileWhen({ all_of: [{ path: '*.ts' }, { content: 'foo' }] }, ctx('a.ts'))).result).toBe(true);
    expect((await evaluateFileWhen({ all_of: [{ path: '*.ts' }, { content: 'bar' }] }, ctx('a.ts'))).result).toBe(false);
    expect((await evaluateFileWhen({ any_of: [{ path: '*.py' }, { content: 'foo' }] }, ctx('a.ts'))).result).toBe(true);
    expect((await evaluateFileWhen({ not: { path: '*.py' } }, ctx('a.ts'))).result).toBe(true);
  });

  it('file-when parser rejects empty boolean arrays and empty mapping', () => {
    expect(() => parseFileWhen({ all_of: [] }, 'ctx', 'scope.files')).toThrow(/'all_of' array must not be empty/);
    expect(() => parseFileWhen({ any_of: [] }, 'ctx', 'scope.files')).toThrow(/'any_of' array must not be empty/);
    expect(() => parseFileWhen({}, 'ctx', 'scope.files')).toThrow(/when mapping must not be empty/);
  });

  it('file-when parser rejects mixing boolean + atomic and >1 boolean operator', () => {
    expect(() => parseFileWhen({ all_of: [{ path: 'a' }], path: 'b' }, 'ctx', 'scope.files')).toThrow(
      /cannot mix boolean operators with atomic clauses/,
    );
    expect(() => parseFileWhen({ all_of: [{ path: 'a' }], any_of: [{ path: 'b' }] }, 'ctx', 'scope.files')).toThrow(
      /at most one boolean operator/,
    );
  });

  it('file-when content atom validates the regex at parse time', () => {
    expect(() => parseFileWhen({ content: '(' }, 'ctx', 'scope.files')).toThrow(/Invalid regex in content/);
  });
});

// =====================================================================
// SECTION F — Propagation: global `when` AND attach-site `when`,
// channel independence.
// SPEC: "Aspect-global when ... and per-attach-site when ... combine via AND
// for each channel path. The aspect is effective on a node if ANY channel's
// path passes BOTH its global and its attach-site filter."
// =====================================================================
describe('F. global + per-attach `when` combine via AND; channels independent', () => {
  function aspect(id: string, when?: WhenPredicate): { id: string; name: string; reviewer: { type: 'llm' }; artifacts: { filename: string; content: string }[]; when?: WhenPredicate } {
    return { id, name: id, reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: 'rule' }], when };
  }

  it('attach-site passes but global fails => not effective (AND)', () => {
    const n = mkNode('n', { type: 'service', aspects: ['a'], aspectWhens: { a: { node: { has_mapping: false } } } });
    // global when requires type=command but the node is a service => global false
    const g = mkGraph([n], { aspects: [aspect('a', { node: { type: 'command' } })] });
    expect(computeEffectiveAspects(n, g).has('a')).toBe(false);
  });

  it('global passes but attach-site fails => not effective (AND)', () => {
    const n = mkNode('n', { type: 'service', aspects: ['a'], aspectWhens: { a: { node: { type: 'command' } } } });
    const g = mkGraph([n], { aspects: [aspect('a', { node: { type: 'service' } })] });
    expect(computeEffectiveAspects(n, g).has('a')).toBe(false);
  });

  it('both global and attach-site pass => effective', () => {
    const n = mkNode('n', { type: 'service', mapping: ['src/x.ts'], aspects: ['a'], aspectWhens: { a: { node: { has_mapping: true } } } });
    const g = mkGraph([n], { aspects: [aspect('a', { node: { type: 'service' } })] });
    expect(computeEffectiveAspects(n, g).has('a')).toBe(true);
  });

  it('channels deliver independently — own attach (no when) wins even if an ancestor attach with when fails', () => {
    // SPEC: effective from channel 1 regardless of whether channel 2's filter passes.
    const parent = mkNode('p', { type: 'module', aspects: ['a'], aspectWhens: { a: { node: { type: 'command' } } } });
    const child = mkNode('p/c', { type: 'service', aspects: ['a'] }); // own attach, no when
    link(parent, child);
    const g = mkGraph([parent, child], { aspects: [aspect('a')] });
    // ancestor's attach-site `when` requires type=command; child is a service => channel 2 fails,
    // but channel 1 (own, no when) delivers it.
    expect(computeEffectiveAspects(child, g).has('a')).toBe(true);
  });
});

// =====================================================================
// SECTION G — Reference-integrity errors (CLI-observable, error-severity)
// SPEC: unknown target_type / descendants.type / node.type => when-unknown-type;
//       unknown relation target => when-unknown-node;
//       unknown consumes_port => when-unknown-port.
// =====================================================================
describe('G. when reference-integrity validation', () => {
  function aspectWithWhen(id: string, when: WhenPredicate) {
    return { id, name: id, reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: 'r' }], when };
  }
  const knownTarget = () => mkNode('pay/svc', { type: 'service', ports: { charge: { description: 'c', aspects: [] } } });

  function codesFor(when: WhenPredicate): string[] {
    const g = mkGraph([knownTarget()], { aspects: [aspectWithWhen('a', when)] });
    return checkWhenReferences(g).map((i) => i.code).filter((c): c is string => c !== undefined);
  }

  it('unknown target_type => when-unknown-type', () => {
    expect(codesFor({ relations: { calls: { target_type: 'ghost-type' } } })).toContain('when-unknown-type');
  });

  it('unknown node.type => when-unknown-type', () => {
    expect(codesFor({ node: { type: 'ghost-type' } })).toContain('when-unknown-type');
  });

  it('unknown descendants.type => when-unknown-type', () => {
    expect(codesFor({ descendants: { type: 'ghost-type' } })).toContain('when-unknown-type');
  });

  it('unknown relation target node => when-unknown-node', () => {
    expect(codesFor({ relations: { calls: { target: 'ghost/node' } } })).toContain('when-unknown-node');
  });

  it('unknown consumes_port on an existing target => when-unknown-port', () => {
    expect(codesFor({ relations: { calls: { target: 'pay/svc', consumes_port: 'NONEXISTENT' } } })).toContain(
      'when-unknown-port',
    );
  });

  it('valid references produce no integrity issues', () => {
    expect(codesFor({ relations: { calls: { target: 'pay/svc', target_type: 'service', consumes_port: 'charge' } } })).toEqual(
      [],
    );
    expect(codesFor({ node: { type: 'service' } })).toEqual([]);
  });

  // NOTE: the SPEC also documents that a bare `consumes_port` (no target) with
  // an unknown port raises when-unknown-port (see its "consumer of a specific
  // port" example). The CODE only validates consumes_port when `target` is also
  // present, so this assertion is intentionally OMITTED and recorded as a
  // suspected bug. See structured output suspectedBugs[].
});
