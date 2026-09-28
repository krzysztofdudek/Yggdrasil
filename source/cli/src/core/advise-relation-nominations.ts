/**
 * source/cli/src/core/advise-relation-nominations.ts — `relation-declared-unused`:
 * a component declares structural relations (`calls`, `uses`, `extends`,
 * `implements`) that no import in its code backs.
 *
 * `yg check` blocks the opposite case — code that depends on a component with no
 * declared relation (`relation-undeclared-dependency`) — but nothing reported a
 * relation left behind once the code stopped using it. Such a relation still
 * widens what the component may depend on and what `yg impact` reports as its
 * blast radius, so it quietly weakens the boundary it was declared to describe.
 * It is advice, not a check finding, because a declared relation with no import
 * is often true: dependency injection, an HTTP call, a process the code starts,
 * or a file a rule reads through the relation stand for a dependency the static
 * extractor cannot see. Which one it is is the user's call, so the item names
 * both answers — remove it, or dismiss the item with the reason it stays.
 *
 * The pairs come from the SAME relation pass `yg advise` already runs for its
 * tunnel count (`computeDependencyBoundary`'s `declaredOnly`: event relations and
 * relations along the parent chain are never listed, nor a relation whose target
 * is not a component, nor one an import of a file the target or a descendant of
 * it owns backs).
 *
 * Only a relation whose silence means something is named: one whose target is
 * imported by SOME code in the repository — the target itself or a descendant of
 * it is the target of at least one detected edge, from any component. A target no
 * import reaches from anywhere (a fixture directory tests read by path, a test
 * suite a rule reads through the relation, a binary an end-to-end test runs, a
 * service called over HTTP) is a component the extractor never sees a dependency
 * on at all, so a missing import from this one source says nothing about whether
 * the relation is stale; naming it would fill the feed with relations that are
 * true. The cost, stated: a relation to a component nothing imports any more
 * (dead code) is not named here either.
 *
 * Nor is a relation between two components that own files in one directory. In
 * Java, Kotlin and Go a directory is a package, and code references its
 * package neighbours with no import at all, so the extractor, which sees
 * imports only, cannot see that dependency.
 * The cost, stated: in a language where neighbours still import each other, a
 * stale relation between two components of one directory is not named.
 *
 * One item per component, naming every target, so a component that declares ten
 * stale relations is one decision rather than ten.
 * Reproducible from the repository as it stands (no timestamp, no local
 * history). Ranked last among the whole-codebase observations.
 *
 * INJECTION HYGIENE (RZ-5): node paths are repository data, rendered through
 * `quoteData`.
 */

import type { Nomination } from './advise-shared.js';
import { CLASS_RANK, hashEvidence, quoteData } from './advise-shared.js';
import { count } from '../utils/count.js';

/** What the relation pass says about declared relations, from one pass. */
export interface RelationBacking {
  /** Declared structural relations no import backs, as (source, target) pairs. */
  declaredOnly: ReadonlyArray<{ source: string; target: string }>;
  /** Every component some code imports from: the targets of the pass's detected edges. */
  importTargets: ReadonlyArray<string>;
  /**
   * The directories that hold files each component owns, for the components
   * `declaredOnly` names (repository-relative, forward slashes). A component
   * absent here shares a directory with nothing.
   */
  directoriesByNode: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** True iff the two components own files in one directory. */
function shareDirectory(a: string, b: string, directoriesByNode: RelationBacking['directoriesByNode']): boolean {
  const of = new Set(directoriesByNode.get(a) ?? []);
  return (directoriesByNode.get(b) ?? []).some((d) => of.has(d));
}

/** True iff some detected edge reaches `target` or a descendant of it. */
function isImportTarget(target: string, importTargets: ReadonlySet<string>): boolean {
  if (importTargets.has(target)) return true;
  const prefix = `${target}/`;
  for (const t of importTargets) if (t.startsWith(prefix)) return true;
  return false;
}

/**
 * One nomination per source component whose declared structural relations name
 * components its code never imports from, while other code does and no directory
 * holds files of both. An empty
 * `declaredOnly` yields nothing.
 */
export function declaredRelationUnusedNominations(backing: RelationBacking): Nomination[] {
  const importTargets = new Set(backing.importTargets);
  const bySource = new Map<string, Set<string>>();
  for (const { source, target } of backing.declaredOnly) {
    if (!isImportTarget(target, importTargets)) continue;
    if (shareDirectory(source, target, backing.directoriesByNode)) continue;
    const set = bySource.get(source) ?? new Set<string>();
    set.add(target);
    bySource.set(source, set);
  }
  const out: Nomination[] = [];
  for (const [source, targetSet] of bySource) {
    const targets = [...targetSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sourceQ = quoteData(source);
    const list = targets.map((t) => `'${quoteData(t)}'`).join(', ');
    out.push({
      id: `relation-declared-unused:${source}`,
      classRank: CLASS_RANK.relationDeclaredUnused,
      what: `Node '${sourceQ}' declares ${count(targets.length, 'relation')} no code backs: ${list}.`,
      why:
        `No file of '${sourceQ}' imports from ${targets.length === 1 ? 'that component' : 'those components'}, ` +
        `though other code does, ` +
        `yet ${targets.length === 1 ? 'the relation' : 'each of these relations'} still allows the dependency and counts in yg impact — ` +
        `either it is stale, or it stands for a dependency the extractor cannot see ` +
        `(dependency injection, a process the code starts, a file a rule reads through it).`,
      next:
        `Remove each stale relation from the relations: of '${sourceQ}' in its yg-node.yaml; for one that stands ` +
        `for an unseen dependency, keep it and dismiss this item with that reason ` +
        `(yg advise dismiss relation-declared-unused:${sourceQ} --reason '…') — ask the user to approve it first.`,
      // Bound to the exact target set: a relation added, removed or newly backed
      // moves the hash, so a dismissed item returns when the evidence moves and
      // disappears once no declared relation of the component is unbacked.
      evidenceHash: hashEvidence({ source: 'relation-declared-unused', node: source, targets: targets.join('|') }),
      evidenceTs: '',
    });
  }
  return out;
}
