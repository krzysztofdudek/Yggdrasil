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
 * is not a component). One item per component, naming every target, so a
 * component that declares ten stale relations is one decision rather than ten.
 * Reproducible from the repository as it stands (no timestamp, no local
 * history). Ranked last among the whole-codebase observations.
 *
 * INJECTION HYGIENE (RZ-5): node paths are repository data, rendered through
 * `quoteData`.
 */

import type { Nomination } from './advise-shared.js';
import { CLASS_RANK, hashEvidence, quoteData } from './advise-shared.js';
import { count } from '../utils/count.js';

/**
 * One nomination per source component whose declared structural relations name
 * components its code never imports from. `declaredOnly` is the relation pass's
 * list of such (source, target) pairs; an empty list yields nothing.
 */
export function declaredRelationUnusedNominations(declaredOnly: ReadonlyArray<{ source: string; target: string }>): Nomination[] {
  const bySource = new Map<string, Set<string>>();
  for (const { source, target } of declaredOnly) {
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
        `yet ${targets.length === 1 ? 'the relation' : 'each of these relations'} still allows the dependency and counts in yg impact — ` +
        `either it is stale, or it stands for a dependency the extractor cannot see ` +
        `(dependency injection, an HTTP call, a process the code starts, a file a rule reads through it).`,
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
