import {
  groupPortalIssues,
  COVERAGE_GROUP_EXCLUDED_CODES,
  FULL_WHAT_CODES,
  type CheckResult,
  type CheckIssue,
  type IssueGroup,
} from './engine-api.js';
import type {
  PortalNode,
  PortalSuppression,
  PortalResidue,
  PortalTypeCoveredFile,
  PortalTypeCoveredUncomputableFile,
  HubEntry,
  WorklistGroup,
  WorklistMember,
  WorklistCoverageBlock,
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
      form: m.form,
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
 * COMPUTABLE type-covered file, path + matched type + whether it is enforced — see
 * `PortalTypeCoveredFile`'s own doc), `typeCoveredUncomputable` (every type-covered
 * file whose cascade an aspect `implies` cycle stopped from ever resolving — disjoint
 * from `typeCovered`, see `PortalTypeCoveredUncomputableFile`'s own doc), and
 * `excludedFiles` (paths under a `coverage.excluded` root) default to `[]` so an
 * existing caller that has not been updated yet still gets a valid `PortalResidue`.
 */
export function buildResidue(
  nodes: PortalNode[],
  uncoveredFiles: string[],
  typeCovered: PortalTypeCoveredFile[] = [],
  excludedFiles: string[] = [],
  typeCoveredUncomputable: PortalTypeCoveredUncomputableFile[] = [],
): PortalResidue {
  const noRuleNodes = nodes
    .filter((n) => n.state === 'no-rule' && n.mapping.length > 0)
    .map((n) => n.path)
    .sort((a, b) => a.localeCompare(b, 'en'));
  return {
    noRuleNodes,
    uncoveredFiles: [...uncoveredFiles].sort((a, b) => a.localeCompare(b, 'en')),
    typeCovered: [...typeCovered].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    typeCoveredUncomputable: [...typeCoveredUncomputable].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    excludedFiles: [...excludedFiles].sort((a, b) => a.localeCompare(b, 'en')),
  };
}

// ── Worklist (rule-grouped, priority-cascade order, coverage partitioned out) ──

/**
 * Build the "needs attention" worklist by REUSING the CLI's own issue grouping (via the
 * facade's `groupPortalIssues`) — the same grouping + priority cascade `yg check` renders —
 * so the portal's worklist can never diverge from the build's ordering.
 *
 * Two shapes a single shared grouping call used to blur are restored here, mirroring what
 * every terminal renderer already does:
 *
 *   - Severity is split BEFORE grouping (the same order `renderErrorSection` /
 *     `renderWarningSection` already run in): an error and a warning that share a code are
 *     grouped SEPARATELY, so one group's badge is never an arbitrary pick between the two
 *     severities a mixed group would otherwise carry.
 *   - Coverage codes (`COVERAGE_GROUP_EXCLUDED_CODES` — `unmapped-files` /
 *     `uncovered-advisory`) never enter grouping at all; they are partitioned out into their
 *     own `coverage` blocks, mirroring `renderUnmappedBlock`'s placement OUTSIDE the grouped
 *     sections. A coverage issue carries a file list, not a rule-shaped why/fix — grouping it
 *     would either drop the file list or fabricate a fake "rule".
 *
 * Each `WorklistGroup` mirrors the CLI's `IssueGroup` field-for-field (`toGroup`), and each
 * member mirrors its source `CheckIssue`'s renderable detail (`toMember`): the subject (a
 * node path or a nodeless `file:` unit), the per-member aspect id ONLY when the group itself
 * is code-only (group-level `aspectId` undefined — e.g. `unverified`, which spans every
 * aspect), the per-member why/next ONLY when the group's members disagree (`divergentWhy` /
 * `divergentNext`), and the multi-line `what` tail ONLY for `FULL_WHAT_CODES` — never a lossy
 * first-member-only summary, the way the old single grouping call rendered every group.
 */
export function buildWorklist(check: CheckResult): { groups: WorklistGroup[]; coverage: WorklistCoverageBlock[] } {
  const all = check.issues as CheckIssue[];
  const coverageIssues = all.filter((i) => COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  const rest = all.filter((i) => !COVERAGE_GROUP_EXCLUDED_CODES.has(i.code));
  const groups = [
    ...groupPortalIssues(rest.filter((i) => i.severity === 'error')).map(toGroup),
    ...groupPortalIssues(rest.filter((i) => i.severity === 'warning')).map(toGroup),
  ];
  return { groups, coverage: coverageIssues.map(toCoverageBlock) };
}

/** One `IssueGroup` → one `WorklistGroup`, field-for-field — the portal's mirror of the CLI's own grouping shape. */
function toGroup(g: IssueGroup): WorklistGroup {
  return {
    code: g.code,
    rule: g.label,
    ...(g.aspectId !== undefined ? { aspectId: g.aspectId } : {}),
    severity: g.severity,
    pairCount: g.pairCount,
    nodeCount: g.nodeCount,
    fileCount: g.fileCount,
    why: g.sharedWhy,
    fix: g.sharedNext,
    divergentWhy: g.divergentWhy,
    divergentNext: g.divergentNext,
    perMemberReason: g.perMemberReason,
    members: g.members.map((m) => toMember(m, g)),
  };
}

/**
 * One `CheckIssue` group member → one `WorklistMember`. `node`/`file` are mutually
 * exclusive — a member either names a graph node or a nodeless `file:` unit. `aspectId` is
 * carried on the MEMBER only when the group itself is code-only (its own `aspectId` is
 * undefined); a group that already names one aspect would only repeat it per member.
 * `why`/`next` are carried only when the group's members DIVERGE — a group with one shared
 * why/fix keeps that single block instead of repeating it on every row. `whatLines` carries
 * the multi-line refusal detail (`messageData.what`'s tail, after its first line) for
 * `FULL_WHAT_CODES` only; every other code's detail already lives in the group's shared why.
 *
 * `what` is the fallback identifier for a member that `node`/`file`/`aspectId` leave
 * unidentified — mirroring the terminal's own two fallbacks (see `WorklistMember.what`'s own
 * doc for the full rationale): a repo-level member (no subject at all) gets the FULL `what`
 * (it IS the finding), and a subject-bearing member with no `aspectId` to annotate it gets
 * just the FIRST line (enough to tell two same-code members apart). Never set for a
 * `FULL_WHAT_CODES` member (its tail already lives in `whatLines`) or once `aspectId` is set
 * (the aspect id already tells the member apart) — `what` never duplicates either.
 */
function toMember(m: CheckIssue, g: IssueGroup): WorklistMember {
  const out: WorklistMember = {};
  if (m.nodePath !== undefined) out.node = m.nodePath;
  else if (m.unitKey?.startsWith('file:')) out.file = m.unitKey.slice('file:'.length);
  if (m.aspectId !== undefined && g.aspectId === undefined) out.aspectId = m.aspectId;
  if (g.divergentWhy && m.messageData.why) out.why = m.messageData.why;
  if (g.divergentNext && m.messageData.next) out.next = m.messageData.next;
  if (FULL_WHAT_CODES.has(m.code)) {
    // Trim trailing whitespace per line FIRST, then drop empties — a whitespace-only line
    // must not survive as a fake "non-empty" continuation (the terminal trims the same way).
    const tail = (m.messageData.what ?? '')
      .split('\n')
      .slice(1)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.length > 0);
    if (tail.length > 0) out.whatLines = tail;
  } else if (out.node === undefined && out.file === undefined) {
    // Repo-level member (no subject at all): the FULL text is the whole finding — surface
    // every line, line 0 included, never just a summary. Trailing whitespace trimmed per
    // line only; blank lines themselves are kept (nothing here is dropped).
    out.what = (m.messageData.what ?? '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  } else if (out.aspectId === undefined && m.messageData.what) {
    // Subject-bearing, but no aspect id to annotate it with: fall back to the first line of
    // `what`, the same distinguishing detail the terminal's member bullet falls back to.
    out.what = m.messageData.what.split('\n')[0];
  }
  return out;
}

/**
 * One coverage-excluded `CheckIssue` (`unmapped-files` / `uncovered-advisory`) → one
 * `WorklistCoverageBlock` — the portal's mirror of `renderUnmappedBlock`'s file-list block.
 * The file list itself lives on `CheckIssue.uncoveredFiles` — verified against the real emit
 * site (`buildCoverageIssue` / `buildCoverageAdvisoryIssue` in
 * core/check-coverage-tiers.ts, both of which set `uncoveredFiles` alongside `messageData`),
 * not assumed to be a generic `files` property.
 */
function toCoverageBlock(i: CheckIssue): WorklistCoverageBlock {
  return {
    code: i.code,
    severity: i.severity,
    files: [...(i.uncoveredFiles ?? [])],
    why: i.messageData.why,
    fix: i.messageData.next,
  };
}
