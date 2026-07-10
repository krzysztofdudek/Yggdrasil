export interface NodeContextData {
  path: string;
  name: string;
  type: string;
  description?: string;
  sourceFiles: string[];
  aspects: NodeContextAspect[];
  flows: NodeContextFlow[];
  dependencies: NodeContextDep[];
  dependentCount: number;
  dependentPaths?: string[]; // populated when <= 5 dependents (plain list)
  parentPath?: string;
  parentType?: string;
  parentReadPath?: string;
  /** Per-aspect subject-file counts (spec §1/§8 observability). Keyed by aspect id. */
  aspectSubjects?: Record<string, NodeAspectSubjects>;
  /** Read-only log-gate state (spec §8/§9). */
  logState?: NodeLogState;
  /**
   * Reviewed-seam override of the built-in high-fan-out ceiling, when declared on
   * this node. Surfaces both the raised number and its recorded justification so
   * the exception stays explicit and auditable in every context view.
   */
  maxDirectRelations?: { limit: number; reason: string };
}

/** Subject-file count for one aspect on this node (spec §1 vacuous-pass observability). */
export interface NodeAspectSubjects {
  /** Number of subject files (per: node) OR pairs (per: file) the aspect produces here. */
  count: number;
  /** True when the aspect is per: file (count is unit count, not file count). */
  perFile: boolean;
}

/** Read-only log-gate state for the node (spec §9). */
export interface NodeLogState {
  /** Whether an entry is required before --approve when source changed. */
  required: boolean;
  /** Whether a fresh entry (newer than the recorded baseline) is present now. */
  freshPresent: boolean;
}

export interface NodeContextAspect {
  id: string;
  name: string;
  description: string;
  source: string;
  verifiedAgainst: string;
  implies?: string[];
  references?: Array<{ path: string; description?: string }>;
  /** Effective enforcement status on this node. Consumers render this. */
  status?: import('../model/graph.js').AspectStatus;
  /** Present only for LLM aspects that ship companion.mjs (per-unit resolver). */
  companionReadPath?: string;
}

export interface NodeContextFlow {
  id: string;
  name: string;
  description: string;
  readPath: string;
}

export interface NodeContextDep {
  path: string;
  relation: string;
  description?: string;
  readPath?: string;
  consumes?: string[];
  portAspects?: Array<{ aspectId: string; verifiedAgainst: string }>;
}

import { truncateDescription } from './truncate.js';
import { toPosixPath } from '../utils/posix.js';

function posixPath(p: string): string {
  return toPosixPath(p);
}

/**
 * Render an aspect's subject-file count (spec §1 vacuous-pass observability).
 * per: node → "N files" (or "0 files — vacuous" when the scope excludes all of
 * them); per: file → "N units (per-file)" so the reader knows each file is its
 * own verification unit, not a single multi-file review.
 */
function formatSubjectCount(s: NodeAspectSubjects): string {
  if (s.count === 0) return '0 files — vacuous';
  if (s.perFile) return `${s.count} unit${s.count === 1 ? '' : 's'} (per-file)`;
  return `${s.count} file${s.count === 1 ? '' : 's'}`;
}

export function formatNodeContext(data: NodeContextData): string {
  const lines: string[] = [];

  // Header
  const desc = data.description ? ` — ${data.description}` : '';
  lines.push(`${posixPath(data.path)}${desc} (${data.type})`);
  lines.push('');

  // Source files
  lines.push(`Source files (${data.sourceFiles.length}):`);
  for (const f of data.sourceFiles) {
    lines.push(`  ${posixPath(f)}`);
  }
  lines.push('');

  // Aspects
  if (data.aspects.length > 0) {
    lines.push(`Must satisfy (${data.aspects.length} aspect${data.aspects.length === 1 ? '' : 's'}):`);
    lines.push('');
    for (const aspect of data.aspects) {
      const status = aspect.status ?? 'enforced';
      lines.push(`  ${aspect.id} [${status}] — ${aspect.description}`);
      lines.push(`    Source: ${posixPath(aspect.source)}`);
      const subjects = data.aspectSubjects?.[aspect.id];
      if (subjects) {
        lines.push(`    Subjects: ${formatSubjectCount(subjects)}`);
      }
      if (status === 'draft') {
        lines.push('    (reviewer skipped; aspect is draft)');
        if (aspect.implies && aspect.implies.length > 0) {
          lines.push(`    Implies: ${aspect.implies.join(', ')}`);
        }
        lines.push('');
        continue;
      }
      lines.push(`    read: ${posixPath(aspect.verifiedAgainst)}`);
      if (aspect.references) {
        for (const ref of aspect.references) {
          if (ref.description && ref.description.length > 0) {
            lines.push(`    read: ${posixPath(ref.path)} — ${truncateDescription(ref.description)}`);
          } else {
            lines.push(`    read: ${posixPath(ref.path)}`);
          }
        }
      }
      if (aspect.companionReadPath) {
        lines.push(`    read: ${posixPath(aspect.companionReadPath)}`);
      }
      if (aspect.implies && aspect.implies.length > 0) {
        lines.push(`    Implies: ${aspect.implies.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Flows
  if (data.flows.length > 0) {
    lines.push(`Participates in (${data.flows.length} flow${data.flows.length === 1 ? '' : 's'}):`);
    for (const flow of data.flows) {
      lines.push(`  ${flow.id} — ${flow.description}`);
      lines.push(`    read: ${posixPath(flow.readPath)}`);
    }
    lines.push('');
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push(`Dependencies (${data.dependencies.length}):`);
    for (const dep of data.dependencies) {
      const depDesc = dep.description ? ` — ${dep.description}` : '';
      const consumes = dep.consumes ? ` — consumes: ${dep.consumes.join(', ')}` : '';
      lines.push(`  ${posixPath(dep.path)} (${dep.relation})${depDesc}${consumes}`);
      if (dep.portAspects && dep.portAspects.length > 0) {
        for (const pa of dep.portAspects) {
          lines.push(`    Required: ${pa.aspectId}`);
        }
      }
      if (dep.readPath) {
        lines.push(`    read: ${posixPath(dep.readPath)}`);
      }
    }
    lines.push('');
  }

  // Reviewed-seam fan-out override — explicit + justified, so it stays auditable.
  if (data.maxDirectRelations) {
    lines.push(
      `Direct-relation ceiling: ${data.maxDirectRelations.limit} (reviewed-seam override; the global default applies to every other node)`,
    );
    lines.push(`  Justification: ${data.maxDirectRelations.reason}`);
    lines.push('');
  }

  // Dependents with consequence framing
  if (data.dependentCount > 0) {
    lines.push(`Dependents (${data.dependentCount}):`);
    if (data.dependentCount >= 16) {
      lines.push(`  HIGH blast radius — changes cascade to ${data.dependentCount} nodes.`);
      lines.push(`  Strongly recommended: yg impact --node ${posixPath(data.path)}`);
    } else if (data.dependentCount >= 6) {
      lines.push(`  Moderate blast radius — changes trigger cascade review on ${data.dependentCount} nodes.`);
      lines.push(`  Run: yg impact --node ${posixPath(data.path)}`);
    } else {
      // 1-5: plain list of dependent node paths
      for (const dep of data.dependentPaths ?? []) {
        lines.push(`  ${posixPath(dep)}`);
      }
      lines.push(`  Run: yg impact --node ${posixPath(data.path)}`);
    }
    lines.push('');
  }

  // Parent
  if (data.parentPath) {
    lines.push(`Parent: ${posixPath(data.parentPath)} (${data.parentType ?? 'module'})`);
    if (data.parentReadPath) {
      lines.push(`  read: ${posixPath(data.parentReadPath)}`);
    }
    lines.push('');
  }

  // Log-gate state (spec §8/§9) — read-only, computed from the fingerprint+lock.
  if (data.logState) {
    const req = data.logState.required ? 'yes' : 'no';
    const fresh = data.logState.freshPresent ? 'yes' : 'no';
    lines.push(`log entry required before --approve: ${req}; fresh entry present: ${fresh}`);
    lines.push('');
  }

  // Workflow footer
  lines.push(`After modifying source files in this node: run yg check, then yg check --approve`);
  lines.push('');

  return lines.join('\n');
}
