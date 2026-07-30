import { truncateDescription } from './truncate.js';
import { toPosixPath } from '../utils/posix.js';

/** Honesty note for a type-covered file's own `relations:` atoms — see conditional-aspects.ts's own "Applicability for a file enforced only by its type" section, which this restates for one file rather than the whole doc. */
export const DERIVED_RELATIONS_NOTE =
  "Dependency conditions here are worked out from this file's own imports, not a declared relation: one resolved import satisfies uses/calls/extends/implements alike, and can never satisfy emits/listens/consumes_port — those always read false for a type-covered file.";

/** Next step for a type-covered file that wants component-level control (log gating, explicit relations, its own aspects). */
export const GRADUATION_NEXT =
  'To give this file a component of its own: add a yg-node.yaml mapping it, then run yg check --approve.';

export interface FileContextData {
  filePath: string;
  ownerPath?: string;
  ownerType?: string;
  aspects: FileContextAspect[];
  dependencies: FileContextDep[];
  dependentCount: number;
  candidates?: Array<{ nodePath: string; mappingPrefix: string }>;
  /**
   * A file enforced by its architecture type alone (no component of its own).
   * Present ONLY when `ownerPath` is absent — replaces the plain "not covered
   * by any node" text with the matched type, the chain, and both halves of
   * what the type attaches: what runs and what does not, with the reason.
   */
  typeCoverage?: FileTypeCoverageView;
}

export interface FileTypeCoverageView {
  typeId: string;
  /** Pre-rendered "inherited rules stop at ..." sentence — a formatter renders already-decided text, never a business-logic enum (that decision belongs to the caller assembling this data). */
  chainTerminationText: string;
  /** Rules that DO apply, same shape as a node's own aspect list. */
  applied: FileContextAspect[];
  /** Rules attached to the type that do NOT apply here, with a pre-rendered reason phrase. */
  dropped: Array<{ aspectId: string; reasonText: string }>;
}

export interface FileContextAspect {
  aspectId: string;
  aspectDescription: string;
  verifiedAgainst: string;
  source?: string; // for implied aspects
  references?: Array<{ path: string; description?: string }>;
  /** Effective enforcement status for this aspect on the owner node. Consumers render this. */
  status?: import('../model/graph.js').AspectStatus;
  /** Present only for LLM aspects that ship companion.mjs (per-unit resolver). */
  companionReadPath?: string;
}

export interface FileContextDep {
  path: string;
  consumed: string[];
}

function posixPath(p: string): string {
  return toPosixPath(p);
}

export function formatFileContext(data: FileContextData): string {
  const lines: string[] = [];

  lines.push(posixPath(data.filePath));
  if (data.ownerPath) {
    lines.push(`  Owner: ${posixPath(data.ownerPath)} (${data.ownerType ?? 'unknown'})`);
  } else {
    lines.push('  Owner: unmapped');
    lines.push('');
    if (data.typeCoverage) {
      const tc = data.typeCoverage;
      lines.push(`  Matched type: ${tc.typeId}`);
      lines.push(`  ${tc.chainTerminationText}`);
      lines.push('');
      if (tc.applied.length > 0) {
        lines.push('  Must satisfy:');
        lines.push('');
        for (const aspect of tc.applied) {
          lines.push(`    ${aspect.aspectId} [${aspect.status ?? 'enforced'}] — ${aspect.aspectDescription}`);
          lines.push(`      read: ${posixPath(aspect.verifiedAgainst)}`);
        }
        lines.push('');
      }
      if (tc.dropped.length > 0) {
        lines.push('  Attached to this type but not enforced here:');
        for (const d of tc.dropped) {
          lines.push(`    ${d.aspectId} — ${d.reasonText}`);
        }
        lines.push('');
      }
      lines.push(`  ${DERIVED_RELATIONS_NOTE}`);
      lines.push('');
      lines.push(`  ${GRADUATION_NEXT}`);
      lines.push('');
      return lines.join('\n');
    }
    if (data.candidates && data.candidates.length > 0) {
      lines.push('  This file is not covered by any node.');
      lines.push('  Candidate nodes (by directory):');
      for (const c of data.candidates) {
        lines.push(`    ${posixPath(c.nodePath)} — ${posixPath(c.mappingPrefix)}`);
      }
      lines.push('  Add this file to a candidate node\'s mapping in yg-node.yaml, or create a new node.');
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');

  // Aspects
  if (data.aspects.length > 0) {
    lines.push('Must satisfy:');
    lines.push('');
    for (const aspect of data.aspects) {
      const status = aspect.status ?? 'enforced';
      lines.push(`  ${aspect.aspectId} [${status}] — ${aspect.aspectDescription}`);
      if (status === 'draft') {
        lines.push('    (reviewer skipped; aspect is draft)');
        if (aspect.source) {
          lines.push(`    Source: ${posixPath(aspect.source)}`);
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
      if (aspect.source) {
        lines.push(`    Source: ${posixPath(aspect.source)}`);
      }
      lines.push('');
    }
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push('Dependencies consumed:');
    for (const dep of data.dependencies) {
      lines.push(`  ${posixPath(dep.path)} — ${dep.consumed.join(', ')}`);
    }
    lines.push('');
  }

  // Dependents
  if (data.dependentCount > 0) {
    lines.push(`Dependents: ${data.dependentCount} nodes — run yg impact --file ${posixPath(data.filePath)}`);
    lines.push('');
  }

  // Back-pointer
  lines.push(`Node context: run yg context --node ${posixPath(data.ownerPath!)}`);
  lines.push('');

  return lines.join('\n');
}
