import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  computeTypeEffectiveAspects,
  computeTypeAspectCascade,
  walkTypeParentChain,
  computeDeclaredAttachedAspects,
} from '../../../src/core/type-effective.js';
import type { TypedEdgeIndex } from '../../../src/relations/pass.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
} from '../../../src/core/graph/aspects.js';
import type { WhenEvalOverrides } from '../../../src/core/when-evaluator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../../..', 'tests', 'fixtures', 'type-level-engine');

// tests/unit/core -> repo root is five levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DOGFOOD_GRAPH = path.join(REPO_ROOT, '.yggdrasil');
const CLI_SRC = path.resolve(__dirname, '..', '..', '..', 'src');

describe('facts a file-level unit presents to a when: predicate', () => {
  it('answers node.type with the matched type and node.has_mapping with true', async () => {
    // A file enforced by its type owns exactly one subject — itself — so a rule
    // gated on "the unit maps something" must apply, and a rule gated on the
    // type id must see the type the file actually matched.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf').map((a) => a.aspectId);
    expect(ids).toContain('gated-on-type'); // when: { node: { type: leaf } }
    expect(ids).toContain('gated-on-has-mapping'); // when: { node: { has_mapping: true } }
  });

  it('answers node.has_port with false — a file-level unit can never own a port', async () => {
    // never-here is gated on has_port. Nothing about a file-level unit can make
    // that true, so the rule must be reported as attached-but-dropped, not as
    // silently absent.
    const graph = await loadGraph(FIXTURE);
    const { effective, drops } = computeTypeAspectCascade(graph, 'src/leaf/a.ts', 'leaf');
    expect(effective.map((a) => a.aspectId)).not.toContain('never-here');
    expect(drops).toContainEqual({ aspectId: 'never-here', reason: 'when-not-satisfied' });
  });

  it('answers descendants: with false — a file-level unit has no hierarchy below it', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf').map((a) => a.aspectId);
    expect(ids).not.toContain('gated-on-descendants');
  });

  it('never throws on any predicate shape the parser accepts', async () => {
    // Evaluation must be total: a predicate that cannot be answered reads false,
    // it never aborts the cascade and never drops the whole file's rule set.
    const graph = await loadGraph(FIXTURE);
    for (const file of ['src/leaf/a.ts', 'src/forked/f.ts', 'src/ep/e.ts', 'src/us/u.ts']) {
      expect(() => computeTypeEffectiveAspects(graph, file, 'leaf')).not.toThrow();
    }
  });
});

describe('the implicit parent chain', () => {
  it('a unique chain contributes every ancestor type default, via parent-chain', async () => {
    const graph = await loadGraph(FIXTURE);
    const list = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf');
    const midRule = list.find((a) => a.aspectId === 'mid-file-rule');
    const topRule = list.find((a) => a.aspectId === 'top-file-rule');
    expect(midRule?.via).toBe('parent-chain');
    expect(topRule?.via).toBe('parent-chain');
  });

  it('truncates at a fork: a type with 2+ parents gets its own defaults and nothing from either', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/forked/f.ts', 'forked').map((a) => a.aspectId);
    expect(ids).toEqual(['forked-own-rule']);
  });

  it('absent parents ends the chain immediately', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'top').map((a) => a.aspectId);
    expect(ids).toEqual(['top-file-rule']);
  });

  it('parents: [] ends the chain immediately', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/ep/e.ts', 'emptyparents').map((a) => a.aspectId);
    expect(ids).toEqual([]);
  });

  it('a parents cycle terminates and yields only the reachable prefix', async () => {
    const graph = await loadGraph(FIXTURE);
    // No real file needs to match cyc-a's own `when` — this function trusts the
    // typeId argument rather than reclassifying the file.
    const ids = computeTypeEffectiveAspects(graph, 'src/cyc/whatever.ts', 'cyc-a').map((a) => a.aspectId);
    expect(ids).toContain('cyc-b-rule'); // reached before the walk revisits cyc-a and stops
  });

  it('a STRICT parent type participates exactly like a non-strict one', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/us/u.ts', 'underStrict').map((a) => a.aspectId);
    expect(ids).toContain('strict-parent-rule');
  });

  it('a classifying parent type (it has its own when:) contributes exactly like a non-classifying one', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer').map((a) => a.aspectId);
    expect(ids).toContain('classifying-parent-rule');
  });

  it('an ancestor type\'s attach-site when: is evaluated against the SUBJECT, never against the ancestor view', async () => {
    // mid-has-mapping-gated is attached to mid (an ancestor of leaf in the
    // chain) with when: { node: { has_mapping: true } }. That reads true
    // against the subject file (a file-level unit always maps itself) and
    // false against the synthetic ancestor view standing in for mid (it
    // carries no meta.mapping at all) — so this discriminates evaluating
    // attachWhen against the subject from evaluating it against the
    // ancestor.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf').map((a) => a.aspectId);
    expect(ids).toContain('mid-has-mapping-gated');
  });
});

describe('walkTypeParentChain — where and why the chain stops', () => {
  it('fork: 2+ parents stops immediately, naming both candidates sorted', async () => {
    const graph = await loadGraph(FIXTURE);
    const { chainTypeIds, termination } = walkTypeParentChain(graph, 'forked');
    expect(chainTypeIds).toEqual([]);
    expect(termination).toEqual({ reason: 'fork', candidates: ['mid', 'top'] });
  });

  it('no-parents: an absent parents: field ends the chain at that type', async () => {
    const graph = await loadGraph(FIXTURE);
    const { chainTypeIds, termination } = walkTypeParentChain(graph, 'top');
    expect(chainTypeIds).toEqual([]);
    expect(termination).toEqual({ reason: 'no-parents', candidates: ['top'] });
  });

  it('empty-parents: an explicit parents: [] ends the chain at that type, distinct from absent', () => {
    // Not loadGraph(FIXTURE): io/architecture-parser.ts:140 normalizes a YAML
    // `parents: []` to `undefined` at load time (parents && parents.length > 0
    // ? parents : undefined) — a real graph can never carry a literal `[]`
    // here, so this branch is exercised with a hand-built Graph instead, the
    // same way pairs-type-coverage.test.ts's buildTypeCoverageGraph does for
    // the identical reason. The fixture's own 'emptyparents' type, once loaded
    // for real, is behaviorally 'no-parents' — see the no-parents case above.
    const graph = {
      architecture: { node_types: { emptyparents: { description: '', parents: [] } } },
    } as unknown as Parameters<typeof walkTypeParentChain>[0];
    const { chainTypeIds, termination } = walkTypeParentChain(graph, 'emptyparents');
    expect(chainTypeIds).toEqual([]);
    expect(termination).toEqual({ reason: 'empty-parents', candidates: ['emptyparents'] });
  });

  it('cycle: a two-type parents cycle stops on revisit, keeping the reachable prefix', async () => {
    const graph = await loadGraph(FIXTURE);
    const { chainTypeIds, termination } = walkTypeParentChain(graph, 'cyc-a');
    expect(chainTypeIds).toEqual(['cyc-b']); // the reachable prefix before the revisit
    expect(termination).toEqual({ reason: 'cycle', candidates: ['cyc-a'] });
  });

  it('a unique multi-level chain never stops early', async () => {
    const graph = await loadGraph(FIXTURE);
    const { chainTypeIds, termination } = walkTypeParentChain(graph, 'leaf');
    expect(chainTypeIds).toEqual(['mid', 'top']);
    expect(termination).toEqual({ reason: 'no-parents', candidates: ['top'] });
  });
});

describe('computeDeclaredAttachedAspects — declared law before when: narrows it', () => {
  it('closes over implies and includes the whole chain, independent of any file', async () => {
    const graph = await loadGraph(FIXTURE);
    const declared = computeDeclaredAttachedAspects(graph, 'leaf', ['mid', 'top']);
    // leaf's own bundle expands to both halves; mid/top contribute their own defaults.
    expect(declared).toEqual(new Set([
      'own-file-rule', 'bundle', 'gated-on-type', 'gated-on-has-mapping',
      'gated-on-descendants', 'never-here', 'drafty', 'two-level-rule',
      'implied-file-rule', 'whole-unit-rule', 'mid-file-rule', 'mid-has-mapping-gated',
      'top-file-rule',
    ]));
  });

  it('a type with no chain and no own aspects declares nothing', async () => {
    const graph = await loadGraph(FIXTURE);
    expect(computeDeclaredAttachedAspects(graph, 'emptyparents', [])).toEqual(new Set());
  });
});

describe('expansion and status', () => {
  it('expands a bundle in full before scope is considered', async () => {
    // A bundle that groups a file-level rule and a whole-unit rule expands
    // entirely here; deciding which half can actually run on a single file is
    // the emission step's job, not this one's.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf').map((a) => a.aspectId);
    expect(ids).toEqual(expect.arrayContaining(['own-file-rule', 'whole-unit-rule']));
  });

  it('honours own-default status inheritance across an implication edge', async () => {
    const graph = await loadGraph(FIXTURE);
    const implied = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf')
      .find((a) => a.aspectId === 'implied-file-rule');
    expect(implied).toEqual({ aspectId: 'implied-file-rule', status: 'advisory', via: 'implies' });
  });

  it('takes the strongest status when two levels deliver the same rule', async () => {
    // leaf declares the rule at its own default (advisory); mid (an ancestor)
    // bumps it to enforced. The stronger obligation wins, exactly as it does
    // for a declared component.
    const graph = await loadGraph(FIXTURE);
    const both = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf')
      .find((a) => a.aspectId === 'two-level-rule');
    expect(both?.status).toBe('enforced');
  });

  it('orders by origin then id, stably', async () => {
    const graph = await loadGraph(FIXTURE);
    const list = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf');
    const rank = { type: 0, 'parent-chain': 1, implies: 2 } as const;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      expect(rank[prev.via] <= rank[cur.via]).toBe(true);
      if (prev.via === cur.via) expect(prev.aspectId < cur.aspectId).toBe(true);
    }
  });

  it('a draft aspect is effective AND reported as a drop with reason draft', async () => {
    // Draft is a DIFFERENT reason from when-not-satisfied: the rule attached
    // and its predicate held, but it is dormant by declared status — a caller
    // must be able to tell the two apart.
    const graph = await loadGraph(FIXTURE);
    const { effective, drops } = computeTypeAspectCascade(graph, 'src/leaf/a.ts', 'leaf');
    expect(effective).toContainEqual({ aspectId: 'drafty', status: 'draft', via: 'type' });
    expect(drops).toContainEqual({ aspectId: 'drafty', reason: 'draft' });
  });
});

/** An edge index literal: the same shape the import resolution produces. */
const edges = (rows: Record<string, Array<{ toFile: string; toOwner: unknown }>>): TypedEdgeIndex => ({
  edgesFrom: (file) => (rows[file] ?? []) as never,
});

describe('relation atoms derived from imports', () => {
  it('is satisfied by an import into a component of the required type', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/owned/o.ts', toOwner: { kind: 'node', path: 'owned', type: 'leaf' } }],
    })).map((a) => a.aspectId);
    expect(ids).toContain('needs-leaf-dependency'); // when: { relations: { uses: { target_type: leaf } } }
    // The positive target:-by-path row: a real component IS on the other end
    // of this edge, named exactly 'owned', so the rule naming that exact path
    // must be satisfied — the sibling test below only ever exercises the
    // NEGATIVE case (no real component on the other end).
    expect(ids).toContain('needs-owned-target'); // when: { relations: { uses: { target: owned } } }
  });

  it('is satisfied by an import into a file enforced by its type with no component of its own', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/leaf/a.ts', toOwner: { kind: 'type-covered', type: 'leaf' } }],
    })).map((a) => a.aspectId);
    expect(ids).toContain('needs-leaf-dependency');
  });

  it('names a specific component only when a real component is on the other end', async () => {
    // A rule that names an exact component cannot be satisfied by a file that has
    // no component — there is nothing to name.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/leaf/a.ts', toOwner: { kind: 'type-covered', type: 'leaf' } }],
    })).map((a) => a.aspectId);
    expect(ids).not.toContain('needs-owned-target'); // when: { relations: { uses: { target: owned } } }
  });

  it('treats one import as evidence for every structural relation kind', async () => {
    // Import analysis cannot tell calling from using from extending, so one
    // resolved import answers all four alike. This is stated in the guidance
    // shipped with the tool, and pinned here so it cannot drift silently.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/owned/o.ts', toOwner: { kind: 'node', path: 'owned', type: 'leaf' } }],
    })).map((a) => a.aspectId);
    expect(ids).toEqual(expect.arrayContaining(['needs-calls-leaf', 'needs-extends-leaf', 'needs-implements-leaf']));
  });

  it('reads event and port atoms as false — an import is no evidence of either', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/owned/o.ts', toOwner: { kind: 'node', path: 'owned', type: 'leaf' } }],
    })).map((a) => a.aspectId);
    expect(ids).not.toContain('needs-emits');
    expect(ids).not.toContain('needs-listens');
    expect(ids).not.toContain('needs-consumed-port');
  });

  it('reads false when every import lands on a file the machine could not type', async () => {
    // The index only ever reports an import whose other end has a settled type —
    // either a component's declared type, or the single type the file matched.
    // An import into a file that matched nothing, or matched two types, is simply
    // ABSENT from the index; there is no "unknown type" value to receive. So the
    // realistic input for a file whose only import lands on such a target is an
    // EMPTY result, and a rule that requires a dependency must read false.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [],
    })).map((a) => a.aspectId);
    expect(ids).not.toContain('needs-leaf-dependency');
  });

  it('reads every structural atom false when no import index is supplied', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer').map((a) => a.aspectId);
    expect(ids).not.toContain('needs-leaf-dependency');
  });

  it('treats an unconstrained relation clause as "at least one import of that kind"', async () => {
    // The on-disk when: grammar currently requires at least one of
    // target_type/target/consumes_port in a relation match, so an "any import
    // of this kind, unconstrained" predicate cannot be authored via YAML today
    // — but RelationMatch's fields are all optional, and matchesRelation's own
    // contract already treats an empty match as "any candidate of that relation
    // type satisfies it". This constructs that (fully legal) predicate value
    // directly, exactly as the existing cascade-characterization suite already
    // does for a hand-built WhenPredicate — it is not a mock of anything
    // internal, just a value the YAML authoring surface has no syntax for yet.
    const graph = await loadGraph(FIXTURE);
    graph.aspects.push({
      name: 'NeedsAnyUses',
      id: 'needs-any-uses',
      reviewer: { type: 'deterministic' },
      artifacts: [],
      when: { relations: { uses: {} } },
    });
    graph.architecture.node_types.consumer.aspects = [
      ...(graph.architecture.node_types.consumer.aspects ?? []),
      'needs-any-uses',
    ];
    const ids = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/owned/o.ts', toOwner: { kind: 'node', path: 'owned', type: 'leaf' } }],
    })).map((a) => a.aspectId);
    expect(ids).toContain('needs-any-uses');
  });
});

describe('the derived-relation overrides reach every forwarding site, not only the attach-site path', () => {
  // Step 5's needs-* rows all gate through an ATTACH-SITE when: (an
  // architecture type's object-form aspects entry), which only exercises
  // ONE of graph/aspects.ts's evaluateWhen call sites. These three tests
  // exercise the other forwarding sites: an aspect's OWN aspect-global
  // when: (checked on the direct channel-3 path AND again by the
  // implies-expansion re-check every visited id goes through, AND by the
  // status fix-point's own-when check for an id reached only via implies),
  // a per-edge impliesWhens clause (checked by the implies-expansion and
  // the status fix-point, each on their own per-edge code path), and the
  // internal hand-off from computeEffectiveAspects into its own
  // computeEffectiveAspectStatuses call (which the draft-propagation gate
  // depends on). Each row below was verified to go RED under the matching
  // local, reverted mutation — see the fix-round report for the mutation
  // trail.
  it('an aspect\'s OWN aspect-global when: is honoured both directly and through implies', async () => {
    // A type-covered target (not a node-kind one) is essential here: a
    // node-kind edge's target_type already resolves correctly through the
    // ordinary graph lookup with NO override at all, so it can never
    // discriminate a dropped override. Only a type-covered target (whose
    // relation carries an empty target: and needs the identity-map override
    // to answer target_type) actually depends on overrides reaching every
    // forwarding site.
    const graph = await loadGraph(FIXTURE);
    const list = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/leaf/a.ts', toOwner: { kind: 'type-covered', type: 'leaf' } }],
    }));
    const ids = list.map((a) => a.aspectId);
    expect(ids).toContain('own-when-relations-gate');
    // implied-own-when-relations is reached ONLY via implies, and its own
    // when: is ALSO relations-gated — its status_inherit: own-default status
    // (advisory) is distinct from the 'enforced' fallback a caller would see
    // if its status fix-point entry silently went missing.
    expect(list).toContainEqual({ aspectId: 'implied-own-when-relations', status: 'advisory', via: 'implies' });
  });

  it('a per-edge impliesWhens relations clause is honoured, distinct from an aspect\'s own when:', async () => {
    // Type-covered target — see the note in the previous test.
    const graph = await loadGraph(FIXTURE);
    const list = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/leaf/a.ts', toOwner: { kind: 'type-covered', type: 'leaf' } }],
    }));
    const ids = list.map((a) => a.aspectId);
    expect(ids).toContain('edge-relations-gate');
    expect(list).toContainEqual({ aspectId: 'implied-via-edge-when', status: 'advisory', via: 'implies' });
  });

  it('a relations-gated draft implier is recognized as draft and still blocks its own implies', async () => {
    // draft-own-when-gate's own when: is relations-gated; recognizing it as
    // draft (so it correctly blocks propagation into blocked-by-draft-gate)
    // depends on computeEffectiveAspects's internal call to
    // computeEffectiveAspectStatuses seeing the same overrides. Type-covered
    // target — see the note in the first test of this block.
    const graph = await loadGraph(FIXTURE);
    const list = computeTypeEffectiveAspects(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/leaf/a.ts', toOwner: { kind: 'type-covered', type: 'leaf' } }],
    }));
    expect(list).toContainEqual({ aspectId: 'draft-own-when-gate', status: 'draft', via: 'type' });
    expect(list.map((a) => a.aspectId)).not.toContain('blocked-by-draft-gate');
  });
});

describe('channels that must never deliver to a type-covered file', () => {
  it('a flow listing the file among its participants delivers nothing', async () => {
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf').map((a) => a.aspectId);
    expect(ids).not.toContain('flow-only-rule');
  });

  it('a port on a real component reached by a derived edge delivers no aspect and no drop (K4)', async () => {
    const graph = await loadGraph(FIXTURE);
    const { effective, drops } = computeTypeAspectCascade(graph, 'src/consumer/c.ts', 'consumer', edges({
      'src/consumer/c.ts': [{ toFile: 'src/owned/o.ts', toOwner: { kind: 'node', path: 'owned', type: 'leaf' } }],
    }));
    expect(effective.map((a) => a.aspectId)).not.toContain('port-only-rule');
    expect(drops.map((d) => d.aspectId)).not.toContain('port-only-rule');
  });

  it('an ancestor COMPONENT\'s own aspects (channel 2) never appear', async () => {
    // The 'forbidden' node (type mid) declares component-only-rule directly on
    // itself — a real channel-1 attachment on a real node, which only ever
    // propagates to that node's real descendants via channel 2. A type-covered
    // file's ancestor chain is entirely synthetic, so it can never reach it.
    const graph = await loadGraph(FIXTURE);
    const ids = computeTypeEffectiveAspects(graph, 'src/leaf/a.ts', 'leaf').map((a) => a.aspectId);
    expect(ids).not.toContain('component-only-rule');
  });
});

describe('regression: the new optional overrides parameter changes nothing on the two-argument path', () => {
  it.skipIf(!existsSync(DOGFOOD_GRAPH))(
    'every node in this repo\'s own graph computes identically whether or not an overrides object is supplied, as long as it only reimplements the default lookup',
    async () => {
      const graph = await loadGraph(REPO_ROOT);
      // Asserts AGREEMENT between the plain two-argument call — the default
      // path, the only calling convention every existing production caller
      // uses — and the identical three-argument call whose override
      // reimplements that exact default lookup, across every real node in
      // this repo's own graph. This is not a claim that any possible
      // threading bug would necessarily surface here; it demonstrates that
      // the two calling conventions agree in practice over this repo's own
      // large, real rule set.
      const identityOverrides: WhenEvalOverrides = {
        relationTargetType: (relation, g) => g.nodes.get(relation.target)?.meta.type,
      };
      for (const [, node] of graph.nodes) {
        const reference = computeEffectiveAspects(node, graph);
        const withOverrides = computeEffectiveAspects(node, graph, identityOverrides);
        expect(withOverrides).toEqual(reference);

        const referenceStatuses = computeEffectiveAspectStatuses(node, graph);
        const withOverridesStatuses = computeEffectiveAspectStatuses(node, graph, identityOverrides);
        expect(withOverridesStatuses).toEqual(referenceStatuses);
      }
    },
  );
});

describe('WhenEvalOverrides never leaks into anything hashed', () => {
  it('appears in exactly two source files (its declaration + this cascade\'s reuse), plus this test', () => {
    // A live evaluation input only — it must never reach pair-hash.ts, never be
    // serialized, never cross the worker boundary. A grep-style count over the
    // real committed source keeps that a checked fact rather than a hopeful
    // comment: a THIRD source file referencing it would mean it started
    // leaking somewhere this task never intended.
    const tsFiles = readdirSync(CLI_SRC, { recursive: true } as { recursive: true })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
      .map((f) => path.join(CLI_SRC, f));
    const filesReferencingIt = tsFiles.filter((f) => readFileSync(f, 'utf-8').includes('WhenEvalOverrides'));
    const relative = filesReferencingIt.map((f) => path.relative(CLI_SRC, f)).sort();
    expect(relative).toEqual(['core/graph/aspects.ts', 'core/type-effective.ts', 'core/when-evaluator.ts']);
  });
});
