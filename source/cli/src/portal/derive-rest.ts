import { groupPortalIssues, type CheckResult, type CheckIssue } from './engine-api.js';
import type {
  PortalNode,
  PortalSuppression,
  PortalResidue,
  PortalTypeCoveredFile,
  HubEntry,
  WorklistGroup,
  SuppressionMarkerInput,
} from './contract.js';

/**
 * derive-rest — the suppression inventory, fan-in/out hubs, the residue (no-rule +
 * uncovered), and the rule-grouped worklist. (The live boundary is its own focused
 * child, derive-boundary.)
 *
 * The worklist mirrors `CheckResult.issues` grouped by rule (reusing the CLI's own
 * `groupIssues`, so the priority cascade is identical to `yg check`'s). Hubs and
 * residue are pure over the already-built PortalNode array. The suppression builder
 * is PURE over a portal-local input shape (adapted by the impure caller from the
 * suppression scan) so this module imports no relations-adapter or command code — it
 * never re-parses or re-scans.
 */

// ── Suppression inventory ───────────────────────────────────────────────────

/** Build the flat suppression inventory, sorted by file then line. */
export function buildSuppressions(markers: SuppressionMarkerInput[]): PortalSuppression[] {
  return markers
    .map((m) => ({
      aspectId: m.aspectId,
      file: m.file,
      line: m.line,
      reason: m.reason,
      ...(m.risk ? { risk: m.risk } : {}),
    }))
    .sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line);
}

// ── Fan-in / fan-out hubs ───────────────────────────────────────────────────

/**
 * Rank nodes by relation degree. fanOut = a node's declared outgoing relations;
 * fanIn = inbound relations (the inversion already on each PortalNode). Both are
 * sorted descending by count, then by path for determinism; zero-degree nodes are
 * omitted (a hub list of zeroes carries no signal).
 */
export function buildHubs(nodes: PortalNode[]): { fanIn: HubEntry[]; fanOut: HubEntry[] } {
  const fanOut: HubEntry[] = [];
  const fanIn: HubEntry[] = [];
  for (const n of nodes) {
    if (n.relationsOut.length > 0) fanOut.push({ path: n.path, count: n.relationsOut.length });
    if (n.relationsIn.length > 0) fanIn.push({ path: n.path, count: n.relationsIn.length });
  }
  return { fanOut: rankHubs(fanOut), fanIn: rankHubs(fanIn) };
}

function rankHubs(entries: HubEntry[]): HubEntry[] {
  return entries.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'en'));
}

// ── Residue (no-rule + uncovered) ───────────────────────────────────────────

/**
 * The residue: the honest "what isn't being verified" ledger. no-rule nodes come
 * from the already-built node states; uncovered files are passed in (the engine's
 * own `scanUncoveredFiles` output, adapted by the caller). `typeCovered` (every
 * type-covered file, path + matched type + whether it is enforced — see
 * `PortalTypeCoveredFile`'s own doc) and `excludedFiles` (paths under a
 * `coverage.excluded` root) default to `[]` so an existing caller that has not been
 * updated yet still gets a valid `PortalResidue`.
 */
export function buildResidue(
  nodes: PortalNode[],
  uncoveredFiles: string[],
  typeCovered: PortalTypeCoveredFile[] = [],
  excludedFiles: string[] = [],
): PortalResidue {
  const noRuleNodes = nodes
    .filter((n) => n.state === 'no-rule' && n.mapping.length > 0)
    .map((n) => n.path)
    .sort((a, b) => a.localeCompare(b, 'en'));
  return {
    noRuleNodes,
    uncoveredFiles: [...uncoveredFiles].sort((a, b) => a.localeCompare(b, 'en')),
    typeCovered: [...typeCovered].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    excludedFiles: [...excludedFiles].sort((a, b) => a.localeCompare(b, 'en')),
  };
}

// ── Worklist (rule-grouped, priority-cascade order) ─────────────────────────

/**
 * Build the worklist by REUSING the CLI's own issue grouping (via the facade's
 * `groupPortalIssues`) — the same grouping + priority cascade `yg check` renders — so
 * the portal's worklist can never diverge from the build's ordering. Each group becomes
 * one WorklistGroup with its shared why/fix and the affected nodes.
 */
export function buildWorklist(check: CheckResult): WorklistGroup[] {
  const groups = groupPortalIssues(check.issues as CheckIssue[]);
  return groups.map((g) => ({
    rule: g.label,
    severity: g.severity,
    why: g.sharedWhy,
    fix: g.sharedNext,
    nodes: [...new Set(g.members.map((m) => m.nodePath ?? '').filter((p) => p.length > 0))].sort((a, b) =>
      a.localeCompare(b, 'en'),
    ),
  }));
}
