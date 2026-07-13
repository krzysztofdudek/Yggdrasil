import { buildOwnerIndex } from '../../relations/owner-index.js';
import type { Graph, GraphNode } from '../../model/graph.js';
import type { SuppressionsReport } from './suppress-scan.js';

/**
 * portal/api/suppress-coverage — a focused derivation over the live suppress scan:
 * map each active waiver to the VERIFICATION units it covers. Split out of
 * suppress-scan.ts so that scan module stays within its file-size boundary; it is
 * the graph-aware interpretation of the scan, so it lives in the same portal facade
 * node (the single audited seam permitted to reach the shared owner index).
 *
 * Its one consumer today is the `yg aspects --health` false-block (fp) signal,
 * which joins these covered units against past refusals to see which of a rule's
 * refusals a human later waived.
 */

/**
 * Resolve, per aspect, the set of VERIFICATION unit keys currently COVERED by a
 * live suppress marker for that aspect — the coverage input the `yg aspects
 * --health` false-block (fp) signal joins against past refusals. For every
 * non-wildcard, non-`enable` marker for an aspect in a file F:
 *   - the file unit `file:F` is covered (a `per: file` refusal on F is waived);
 *   - every node whose subject set includes F is covered: F's OWNING node and each
 *     ANCESTOR of it, since a `per: node` aspect on an ancestor reviews F too. So a
 *     refusal recorded on `node:<owner>` or any `node:<ancestor>` reads as covered.
 * `enable` markers are range terminators, not waivers; a wildcard `*` marker
 * silences EVERY aspect and is deliberately never attributed to one — mirroring the
 * `suppresses` column so fp attribution stays precise (a wildcard waiver is a broad,
 * separately-summarized concern, never a per-rule false-block signal).
 *
 * Reuses the SHARED owner index (the same file→node resolution the relation and
 * coverage layers use) so a marker's file maps to a unit exactly as the engine
 * maps it. Pure over the live scan + graph ownership; no I/O of its own.
 *
 * Granularity caveat (honest limitation): coverage is FILE / NODE-level, never
 * per LINE — a marker anywhere in a file covers that file's unit and its owning /
 * ancestor node units wholesale. So the fp consumer that joins these covered units
 * against past refusals can, in the rare coincidence where a same-aspect waiver and
 * an unrelated genuine refusal land on the SAME unit, over-count that unrelated
 * refusal as a false block. This is bounded, thin-data-labelled, and never gates;
 * line-level attribution would require line-carrying refusal events, deliberately
 * not added for a non-gating signal.
 */
export function resolveSuppressedUnitsByAspect(
  graph: Graph,
  report: SuppressionsReport,
): Map<string, Set<string>> {
  const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
  const out = new Map<string, Set<string>>();
  const add = (aspectId: string, unitKey: string): void => {
    let s = out.get(aspectId);
    if (s === undefined) {
      s = new Set<string>();
      out.set(aspectId, s);
    }
    s.add(unitKey);
  };

  for (const { file, markers } of report.fileEntries) {
    // Node units the marker's file belongs to: the owning node and every ancestor.
    const nodeUnits: string[] = [];
    const owner = ownerOf(file);
    if (owner !== undefined) {
      let node: GraphNode | null | undefined = graph.nodes.get(owner);
      while (node) {
        nodeUnits.push(`node:${node.path}`);
        node = node.parent;
      }
      if (nodeUnits.length === 0) nodeUnits.push(`node:${owner}`);
    }
    const fileUnitKey = `file:${file}`;

    for (const m of markers) {
      if (m.wildcard || m.kind === 'enable') continue;
      add(m.aspectId, fileUnitKey);
      for (const nu of nodeUnits) add(m.aspectId, nu);
    }
  }
  return out;
}
