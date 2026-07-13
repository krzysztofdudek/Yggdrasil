import type { Graph } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { issueMsg } from './shared.js';
import { readIncidents } from '../../io/incidents-store.js';

// --- incident-ledger-out-of-order: committed testimony must ascend in time ---

/**
 * Incident-ledger integrity linter (WARNING, never blocking). The committed
 * `.yggdrasil/incidents.md` is append-only human testimony whose entry datetimes
 * are STRICTLY ASCENDING. This check reads the ledger through the persistence
 * adapter (engine files do no direct fs) and warns when two consecutive entries
 * are NOT strictly ascending — the signature of a hand-edit or a reordering merge.
 *
 * Design invariants (spec §3.2 / V3):
 *   - NON-GATING. Emitted at `severity: 'warning'`, outside every blocking code
 *     set, so it never fails `yg check`, never aborts `--approve`, and never
 *     becomes a blocking `suggestedNext`. The tower's only external oracle must
 *     never be able to break CI because a human's diff was untidy.
 *   - ABSENCE TOLERATED. No file ⇒ no entries ⇒ no warning; a repo that has never
 *     recorded an incident is honest, not broken.
 *   - NO HASH BASELINE (v1). The ledger is testimony, not reviewed source, so the
 *     only integrity signal is this ordering warning — never a content hash that
 *     could go stale and block.
 *
 * Ordering is compared on `Date.parse` epoch milliseconds. An entry whose datetime
 * does not parse cannot be ordered, so it is skipped rather than reported — the
 * check never fabricates a false out-of-order signal. `<=` (not `<`) is the
 * violation test, so two equal datetimes are also flagged (strictly ascending).
 * Every out-of-order transition is one warning under the shared code, so the
 * grouped renderer collapses them into a single block.
 */
export function checkIncidentLedger(graph: Graph): ValidationIssue[] {
  const { entries } = readIncidents(graph.rootPath);
  const issues: ValidationIssue[] = [];

  let prevEpoch: number | undefined;
  for (const entry of entries) {
    const epoch = Date.parse(entry.datetime);
    if (Number.isNaN(epoch)) continue; // unparseable → cannot order; never a false warning
    if (prevEpoch !== undefined && epoch <= prevEpoch) {
      const msgData: IssueMessage = {
        what: `incidents.md datetimes are not strictly ascending at '${entry.datetime}'.`,
        why: 'the ledger is append-only human testimony — out-of-order entries suggest a hand-edit or a reordering merge.',
        next: 'reorder so datetimes strictly ascend, or re-add the incident with a current timestamp — never fabricate a datetime.',
      };
      issues.push({
        severity: 'warning',
        code: 'incident-ledger-out-of-order',
        rule: 'incident-ledger-out-of-order',
        ...issueMsg(msgData),
        messageData: msgData,
      });
    }
    prevEpoch = epoch;
  }

  return issues;
}
