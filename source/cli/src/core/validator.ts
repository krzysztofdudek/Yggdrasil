// yg-suppress-disable(silent-missing-files) validator.ts reads no optional files or directories itself — every file/dir read is delegated to the loader and parsers, so the aspect is vacuously satisfied; the per-node reviewer evaluates the file in isolation and cannot observe it performs no optional reads.
import type { Graph } from '../model/graph.js';
import type { ValidationResult, ValidationIssue } from '../model/validation.js';
import type { IssueMessage } from '../model/validation.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { issueMsg } from './checks/shared.js';
import { toPosixPath } from '../utils/posix.js';
import {
  checkTypeUnknownParent,
  checkArchitectureParentCycles,
  checkEnforceStrictWithoutWhen,
  checkTypeWithoutWhenWithMapping,
  checkTypeWhenMismatch,
  checkArchitectureConstraints,
  checkPortAspectsDefined,
  checkPortConsumes,
} from './checks/architecture.js';
import {
  checkDanglingAspectRefs,
  checkAspectIds,
  checkAspectIdUniqueness,
  checkImpliedAspectsExist,
  checkImpliesNoCycles,
  checkOrphanedAspects,
  checkWhenReferences,
} from './checks/aspects.js';
import {
  checkAspectRuleSources,
  checkReviewerPresence,
  checkAspectTierReferences,
  checkAspectErrsDirection,
  checkAspectReferences,
  checkAspectStatusDowngrade,
  checkAspectEffectiveNowhere,
} from './checks/aspect-contracts.js';
import { checkIncidentLedger } from './checks/incident-ledger.js';
import {
  checkFileMappingGitignored,
  checkFileDuplicateMapping,
  checkStrictBackwardCoverage,
  checkMappingOverlap,
  checkMappingPathsExist,
  checkMappingEscapesRepo,
  checkDirectoriesHaveNodeYaml,
} from './checks/mapping.js';
import {
  checkRelationTargets,
  checkHighFanOut,
  checkUnpairedEvents,
  checkBrokenFlowRefs,
  checkNoCycles,
  checkMissingDescriptions,
} from './checks/relations.js';

// Architecture-level errors that abort per-node and global validation stages.
const ARCHITECTURE_FATAL_CODES = new Set<string>([
  'type-unknown-parent',
  'architecture-cycle',
  'enforce-strict-without-when',
  'when-predicate-invalid',
]);

export async function validate(graph: Graph, scope: string = 'all'): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  if (graph.configError) {
    const msgData: IssueMessage = graph.configErrorMessage ?? {
      what: 'yg-config.yaml failed to parse.',
      why: graph.configError,
      next: 'Fix the syntax error in .yggdrasil/yg-config.yaml.',
    };
    const errorCode = graph.configErrorCode ?? 'config-invalid';
    issues.push({
      severity: 'error',
      code: errorCode,
      rule: 'invalid-config',
      ...issueMsg(msgData),
      messageData: msgData,
    });
  }

  for (const { nodePath, messageData } of graph.nodeParseErrors ?? []) {
    issues.push({
      severity: 'error',
      code: 'yaml-invalid',
      rule: 'invalid-node-yaml',
      ...issueMsg(messageData),
      messageData,
      nodePath,
    });
  }

  for (const { code, messageData } of graph.aspectParseErrors ?? []) {
    issues.push({
      severity: 'error',
      code,
      rule: code,
      ...issueMsg(messageData),
      messageData,
    });
  }

  // Stage 1: architecture file failed to parse — cannot proceed.
  if (graph.architectureError) {
    const archErr = graph.architectureError;
    if (typeof archErr === 'object' && archErr.code === 'when-predicate-invalid') {
      issues.push({
        severity: 'error',
        code: 'when-predicate-invalid',
        rule: 'when-predicate-invalid',
        ...issueMsg(archErr.messageData),
        messageData: archErr.messageData,
      });
    } else {
      const archInvalid = archErr as { code: 'architecture-invalid'; messageData: IssueMessage };
      issues.push({
        severity: 'error',
        code: 'architecture-invalid',
        rule: 'architecture-invalid',
        ...issueMsg(archInvalid.messageData),
        messageData: archInvalid.messageData,
      });
    }
    return { issues, nodesScanned: 0 };
  }

  // Stage 2: schema-independent checks (run even when architecture has semantic errors).
  if (!graph.configError) {
    // Node type validation uses architecture file (yg-architecture.yaml), not config
    issues.push(...checkDanglingAspectRefs(graph));
    issues.push(...checkAspectIds(graph));
    issues.push(...checkAspectIdUniqueness(graph));
    issues.push(...checkImpliedAspectsExist(graph));
    issues.push(...checkImpliesNoCycles(graph));
    issues.push(...checkHighFanOut(graph));
    issues.push(...checkMissingDescriptions(graph));
    issues.push(...(await checkReviewerPresence(graph)));
    // Incident-ledger integrity (spec §3.2): a NON-blocking WARNING when the
    // committed incidents.md datetimes are not strictly ascending. Config-
    // independent and absence-tolerant; never gates `yg check` (severity warning,
    // outside every blocking code set).
    issues.push(...checkIncidentLedger(graph));
    issues.push(...checkAspectTierReferences(graph));
    issues.push(...checkAspectErrsDirection(graph));
  }

  // Stage 3: architecture-level checks — fatal errors short-circuit per-node + global stages.
  const archIssues: ValidationIssue[] = [];
  archIssues.push(...checkTypeUnknownParent(graph));
  archIssues.push(...checkArchitectureParentCycles(graph));
  archIssues.push(...checkEnforceStrictWithoutWhen(graph));
  issues.push(...archIssues);
  const hasArchFatal = archIssues.some(
    (i) => i.severity === 'error' && i.code !== undefined && ARCHITECTURE_FATAL_CODES.has(i.code),
  );
  if (hasArchFatal) {
    return { issues, nodesScanned: 0 };
  }

  // Shared cache for file-content reads in Stage 4/5.
  const cache = new FileContentCache();

  // Stage 4: per-node checks.
  issues.push(...checkTypeWithoutWhenWithMapping(graph));
  const whenMismatchOutcome = await checkTypeWhenMismatch(graph, cache);
  issues.push(...whenMismatchOutcome.issues);
  const allUnreadable: ValidationIssue[] = [...whenMismatchOutcome.unreadable];
  issues.push(...(await checkFileMappingGitignored(graph)));

  issues.push(...checkRelationTargets(graph));
  issues.push(...checkNoCycles(graph));
  issues.push(...(await checkMappingOverlap(graph)));
  issues.push(...checkMappingEscapesRepo(graph));
  issues.push(...(await checkMappingPathsExist(graph)));
  issues.push(...checkBrokenFlowRefs(graph));
  issues.push(...(await checkDirectoriesHaveNodeYaml(graph)));
  issues.push(...checkUnpairedEvents(graph));
  issues.push(...checkArchitectureConstraints(graph));
  issues.push(...checkPortAspectsDefined(graph));
  issues.push(...checkPortConsumes(graph));
  issues.push(...checkOrphanedAspects(graph));
  issues.push(...checkWhenReferences(graph));
  issues.push(...checkAspectRuleSources(graph));
  issues.push(...(await checkAspectReferences(graph)));
  issues.push(...checkAspectStatusDowngrade(graph));
  // Dead-attach linter (warning): a rule source effective on zero nodes after
  // the full cascade + when. Runs here (post arch-fatal short-circuit) because it
  // evaluates `when` predicates, which require a structurally-valid architecture.
  issues.push(...checkAspectEffectiveNowhere(graph));

  // Stage 5: global checks.
  issues.push(...checkFileDuplicateMapping(graph));
  const strictOutcome = await checkStrictBackwardCoverage(graph, cache);
  issues.push(...strictOutcome.issues);
  allUnreadable.push(...strictOutcome.unreadable);

  // De-duplicate file-unreadable by what (same file may surface from multiple checks).
  const seenUnreadable = new Set<string>();
  for (const u of allUnreadable) {
    if (!seenUnreadable.has(u.messageData.what)) {
      seenUnreadable.add(u.messageData.what);
      issues.push(u);
    }
  }

  let filtered = issues;
  let nodesScanned = graph.nodes.size;
  const normalizedScope = toPosixPath(scope.trim());
  if (normalizedScope !== 'all' && normalizedScope) {
    if (!graph.nodes.has(normalizedScope)) {
      // Check if the node exists but has a parse error
      const parseError = (graph.nodeParseErrors ?? []).find(
        (e) => e.nodePath === normalizedScope || normalizedScope.startsWith(e.nodePath + '/'),
      );
      if (parseError) {
        return {
          issues: [{
            severity: 'error',
            code: 'yaml-invalid',
            rule: 'invalid-node-yaml',
            ...issueMsg(parseError.messageData),
            messageData: parseError.messageData,
            nodePath: parseError.nodePath,
          }],
          nodesScanned: 0,
        };
      }
      const msgData = {
        what: `Node not found: ${normalizedScope}`,
        why: 'Validation scope references a node that does not exist in the graph.',
        next: 'Check the node path and try again.',
      };
      return {
        issues: [{ severity: 'error', code: 'invalid-scope', rule: 'invalid-scope', ...issueMsg(msgData), messageData: msgData }],
        nodesScanned: 0,
      };
    }
    const scopePrefix = normalizedScope + '/';
    filtered = issues.filter((i) => !i.nodePath || i.nodePath === normalizedScope || i.nodePath.startsWith(scopePrefix));
    nodesScanned = [...graph.nodes.keys()].filter((p) => p === normalizedScope || p.startsWith(scopePrefix)).length;
  }

  return { issues: filtered, nodesScanned };
}

// yg-suppress-enable(silent-missing-files)
