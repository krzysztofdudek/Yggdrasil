/**
 * source/cli/src/core/advise-imported-nominations.ts — the attention items that
 * came from OUTSIDE this graph.
 *
 * Every other nomination source derives a signal from the graph itself. This one
 * reads what another tool measured and handed over, and turns each proposal into
 * an item with the same standing as one the graph nominated — no more. It lives
 * apart from the derived sources for exactly that reason: a reader (and a rule)
 * can see at a glance which file turns this repository's own evidence into
 * items, and which one carries somebody else's.
 *
 * INJECTION HYGIENE, as everywhere in the feed: every value here is UNTRUSTED —
 * it came from another program — so each is rendered as QUOTED DATA WITH
 * PROVENANCE and never interpolated into a narrator-voice instruction. `next` is
 * written in the graph's own terms and ends by noting that acting requires the
 * user's approval: importing was never accepting.
 */

import type { ImportedAdvice } from '../io/advise-imported-store.js';
import type { Nomination } from './advise-nominations.js';
import { CLASS_RANK, asApprovalNext, hashEvidence, quoteData } from './advise-nominations.js';

/** How many of a producer's evidence keys the feed shows before it stops. */
const MAX_EVIDENCE_KEYS = 6;

/**
 * A nested evidence object folded to one canonical string, keys sorted at every
 * level, so it can enter the flat snapshot shape every nomination class shares
 * without widening it. Ordering by key at each level is what makes the fold
 * stable across producers that emit the same facts in a different order.
 */
function canonicalEvidenceText(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceText).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalEvidenceText(v)}`).join(',')}}`;
}

/**
 * One evidence value as text for the feed. A scalar reads as itself; anything
 * nested reads as its canonical form rather than as the language's own
 * stringification, which would render a whole measured object as a placeholder
 * word and quietly show the reader nothing. The length bound still applies
 * afterwards, so a large object is truncated visibly rather than dumped.
 */
function evidenceValueText(value: unknown): string {
  return value === null || typeof value !== 'object' ? String(value) : canonicalEvidenceText(value);
}

/** The human action each kind of imported proposal asks for, in the graph's own terms. */
export function importedAction(record: ImportedAdvice): string {
  const nodes = record.nodes.map((n) => quoteData(n));
  switch (record.kind) {
    case 'relation':
      return nodes.length >= 2
        ? `Decide whether ${nodes[0]} genuinely depends on ${nodes[1]} — if it does, declare the relation (and a port on ${nodes[1]} if the dependency carries an obligation); if it does not, leave the graph as it is.`
        : `Decide whether ${nodes[0]} has an undeclared dependency, and declare the relation if it does.`;
    case 'split':
      return `Decide whether ${nodes[0]} is really two things${
        record.candidates && record.candidates.length > 0
          ? ` — the proposal names ${record.candidates.map((c) => quoteData(c)).join(' and ')}`
          : ''
      }, and split it only if the seam is real.`;
    case 'port':
      return `Decide whether ${nodes[0]} publishes an obligation its consumers must satisfy, and give it a port if it does.`;
    case 'rule':
      return `Decide whether this is a rule worth writing, and add it as a draft aspect if it is.`;
  }
}

/**
 * One nomination per imported proposal.
 *
 * Everything the producer said is rendered as QUOTED DATA under its name — its
 * own sentence, its confidence, its evidence — and never as a narrator-voice
 * instruction. The `next` is written in the graph's own terms and, like every
 * other nomination, ends by noting that acting requires the user's approval:
 * importing was never accepting.
 */
export function importedNominations(records: readonly ImportedAdvice[]): Nomination[] {
  return records.map((record) => {
    const sourceQ = quoteData(record.source);
    const atQ = record.at === null ? 'an unnamed commit' : `commit ${quoteData(record.at.slice(0, 12))}`;
    const confidence = record.confidence === undefined ? '' : ` confidence ${record.confidence}.`;
    const evidenceKeys = Object.keys(record.evidence);
    const evidence =
      evidenceKeys.length === 0
        ? ' It gave no evidence.'
        : ` Its evidence: ${evidenceKeys
            .slice(0, MAX_EVIDENCE_KEYS)
            .map((k) => `${quoteData(k)}=${quoteData(evidenceValueText(record.evidence[k]))}`)
            .join(', ')}.`;
    return {
      id: `imported:${record.source}:${record.key}`,
      classRank: CLASS_RANK.imported,
      what: `${sourceQ} proposes (${record.kind}): "${quoteData(record.text)}".`,
      why: `measured by ${sourceQ} at ${atQ}, about ${record.nodes.map((n) => quoteData(n)).join(', ')}.${confidence}${evidence} It is a proposal from outside this graph, not a finding of its own.`,
      next: asApprovalNext(importedAction(record)),
      evidenceHash: hashEvidence({
        source: 'imported',
        producer: record.source,
        key: record.key,
        // The producer's evidence object folded as its canonical text: the
        // snapshot is a flat string/number map by contract, and the evidence a
        // proposal rests on is nested. Folding its canonical form keeps the
        // binding exact — a changed measurement is a changed item — without
        // widening the snapshot shape every other class shares.
        evidence: canonicalEvidenceText(record.evidence),
      }),
      evidenceTs: record.ts,
      provenance: { source: record.source, at: record.at },
    };
  });
}
