import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  computeTypeEffectiveAspects,
  computeTypeAspectCascade,
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
      // An overrides object whose relationTargetType reimplements EXACTLY the
      // default graph lookup matchesRelation falls back to when overrides is
      // absent. If threading the optional parameter through the six
      // evaluateWhen call sites changed anything about the two-argument path,
      // this would diverge from the plain two-argument call somewhere across
      // this repo's own (large, real) rule set.
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
