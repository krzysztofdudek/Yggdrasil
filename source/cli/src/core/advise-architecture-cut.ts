/**
 * source/cli/src/core/advise-architecture-cut.ts — the architecture-cut
 * nomination source: a group of module blocks that mutually depend, found in the
 * structural quotient's cycles.
 *
 * Split out of the nomination engine beside it for room rather than for
 * principle: that file is the one this repository's own reviewer prompt runs
 * closest to its ceiling on, and a self-contained source with one entry point is
 * the cheapest thing to move out of it. Nothing about the class changed — it is
 * computed from DECLARED relations only, so it reproduces across machines, and
 * its item is worded and bound exactly as before.
 */

import type { ArchitectureCutCycle, Nomination } from './advise-nominations.js';
import { CLASS_RANK, hashEvidence, quoteData } from './advise-nominations.js';


/**
 * Turn each non-trivial quotient cycle into ONE T2 nomination. WHAT names the
 * module GROUPS plainly (quoted block ids), WHY states they depend on each other
 * in a loop with the quotient depth as provenance, NEXT proposes a cut or a port
 * contract and ends with the literal consent suffix. Derives from the committed
 * graph ⇒ reproducible (no `local analysis` label, no timestamp). Plain language
 * only — never "SCC" / "strongly connected component". Ranks below family.
 */
export function architectureCutNominations(cycles: ArchitectureCutCycle[]): Nomination[] {
  const out: Nomination[] = [];
  for (const cycle of cycles) {
    const blockList = cycle.blocks.map((b: string) => `'${quoteData(b)}'`).join(', ');
    const provenance = `structure quotient depth ${cycle.depth}`;
    out.push({
      id: `architecture-cut:depth${cycle.depth}:${cycle.blocks.join('|')}`,
      classRank: CLASS_RANK.architectureCut,
      what: `Module groups ${blockList} depend on each other in a loop.`,
      why:
        `at ${provenance}, these module groups each reach the other by following declared ` +
        `dependencies — a dependency loop, not a one-way layering. Provenance: ${provenance}.`,
      next: `Consider a cut between these module groups, or declare a contract (a port) across the boundary — requires your consent.`,
      // Bind to the depth + the exact block set: a changed loop (blocks added or a
      // cut declared) moves the hash, so a dismissed item returns when the
      // structure moves; a resolved loop stops being emitted entirely.
      evidenceHash: hashEvidence({
        source: 'architecture-cut',
        depth: cycle.depth,
        blocks: cycle.blocks.join('|'),
      }),
      // Reproducible from the committed graph — no meaningful recency key, so all
      // architecture-cut items tie on freshness and break to stable id order.
      evidenceTs: '',
    });
  }
  return out;
}
