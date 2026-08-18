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
  /**
   * True when the lock does NOT currently hold a valid verdict for this
   * (aspectId, file) pair — `[enforced]` names architecture-level status,
   * never a recorded verdict. Set from the SAME per-pair re-verification
   * plain `yg check` performs for the identical pair
   * (`core/verify-lock.ts#verifyPairs`, scoped to just this file's own
   * nodeless pairs), so a stale entry (this file edited since the verdict
   * was recorded) sets this exactly as `yg check`'s own qualified "N
   * unverified" wording would count it, not only a pair the lock has never
   * seen at all. Type-covered-file view only (`build-context.ts`'s
   * `buildTypeCoveredFileContextData`); a node-owned file's own aspect list
   * never sets this field.
   */
  unverified?: boolean;
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
  } else if (data.typeCoverage) {
    // "unmapped" is the product's own word for genuinely NOT covered — false
    // here, and self-contradicted two lines later by "Matched type:" on the
    // same file. Lead with the same ownership vocabulary `yg owner --file`
    // already uses for the identical file ("-> type:X").
    const tc = data.typeCoverage;
    lines.push(`  Owner: type:${tc.typeId}`);
    lines.push('');
    lines.push(`  Matched type: ${tc.typeId}`);
    lines.push(`  ${tc.chainTerminationText}`);
    lines.push('');
    if (tc.applied.length > 0) {
      lines.push('  Must satisfy:');
      lines.push('');
      for (const aspect of tc.applied) {
        const caveat = aspect.unverified ? ', unverified' : '';
        lines.push(`    ${aspect.aspectId} [${aspect.status ?? 'enforced'}${caveat}] — ${aspect.aspectDescription}`);
        lines.push(`      read: ${posixPath(aspect.verifiedAgainst)}`);
      }
      lines.push('');
    } else {
      lines.push('  No rules from this type apply to this file — it satisfies coverage with no enforcement.');
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
  } else {
    lines.push('  Owner: unmapped');
    lines.push('');
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

export interface FileBriefExtras {
  /** "editing this file invalidates N pairs (M free / K reviewer pairs) — …" — pre-rendered by the caller; absent → line omitted */
  armPreviewText?: string;
  /** "your change so far: N files; this file is in it" — pre-rendered; absent → no scope section */
  scopeHeaderText?: string;
  /** aspectId → 'yours' | 'inherited' (only when the change was measured) */
  scopeByAspect?: Map<string, 'yours' | 'inherited'>;
  /** pre-rendered owner log-gate line; absent → line omitted */
  logGateText?: string;
  /** pre-rendered owner flows line; absent → line omitted */
  flowsText?: string;
  /** up to 3 pre-rendered "next:" lines */
  nextPointers: string[];
}

const BRIEF_ASPECT_CAP = 8;

/**
 * The first sentence of a rule's description, capped by the SAME 80-char helper
 * the full view already applies to reference descriptions — a brief that can be
 * blown out to one 2000-character line by one verbose rule is not a brief.
 */
function briefDescription(text: string): string {
  const trimmed = text.trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(trimmed);
  return truncateDescription((m ? m[0] : trimmed).trim());
}

function briefAspectLines(a: FileContextAspect, scope?: 'yours' | 'inherited'): string[] {
  const status = a.status ?? 'enforced';
  const caveat = a.unverified ? ', unverified' : '';
  const suffix = scope === undefined ? '' : ` (${scope})`;
  const head = `  [${status}${caveat}] ${a.aspectId} — ${briefDescription(a.aspectDescription)}${suffix}`;
  // A draft rule has no reviewer and no verdict; the full view withholds its
  // read path for exactly that reason, and the compact view must not contradict
  // it by pointing at a rule source nothing is judged against.
  if (status === 'draft') return [head, '    (reviewer skipped; aspect is draft)'];
  return [head, `    read: ${posixPath(a.verifiedAgainst)}`];
}

export function formatFileContextBrief(data: FileContextData, extras: FileBriefExtras): string {
  const lines: string[] = [];
  lines.push(posixPath(data.filePath));
  if (data.ownerPath) {
    lines.push(`  Owner: ${posixPath(data.ownerPath)} (${data.ownerType ?? 'unknown'})`);
  } else if (data.typeCoverage) {
    lines.push(`  Owner: type:${data.typeCoverage.typeId}`);
  } else {
    lines.push('  Owner: unmapped');
    if (data.candidates && data.candidates.length > 0) {
      lines.push(`  Candidate nodes: ${data.candidates.map((c) => posixPath(c.nodePath)).join(' · ')}`);
    }
  }
  if (extras.scopeHeaderText) lines.push(`  ${extras.scopeHeaderText}`);
  const aspects = data.ownerPath ? data.aspects : (data.typeCoverage?.applied ?? []);
  if (aspects.length > 0) {
    lines.push('  Must satisfy:');
    for (const a of aspects.slice(0, BRIEF_ASPECT_CAP)) {
      lines.push(...briefAspectLines(a, extras.scopeByAspect?.get(a.aspectId)));
    }
    if (aspects.length > BRIEF_ASPECT_CAP) {
      lines.push(`  … and ${aspects.length - BRIEF_ASPECT_CAP} more — run yg context --file ${posixPath(data.filePath)} for all`);
    }
  }
  if (extras.armPreviewText) lines.push(`  ${extras.armPreviewText}`);
  if (data.dependencies.length > 0) {
    lines.push(`  Depends on: ${data.dependencies.slice(0, 3).map((d) => posixPath(d.path)).join(' · ')}${data.dependencies.length > 3 ? ' · …' : ''}`);
  }
  if (data.dependentCount > 0) lines.push(`  Dependents: ${data.dependentCount} nodes`);
  if (extras.logGateText) lines.push(`  ${extras.logGateText}`);
  if (extras.flowsText) lines.push(`  ${extras.flowsText}`);
  for (const p of extras.nextPointers.slice(0, 3)) lines.push(`  ${p}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Expand exactly one rule from this file's own effective set in full — the
 * FULL untruncated description, its status tag, and every read path — for
 * `yg context --file <path> --aspect <id>`.
 *
 * Returns `undefined` when `aspectId` is not among the file's effective
 * aspects (`data.aspects` for a node-owned file, `data.typeCoverage.applied`
 * for a type-covered one) — the CLI owns the unknown-id error, not the
 * formatter.
 */
export function formatFileContextAspect(data: FileContextData, aspectId: string): string | undefined {
  const aspects = data.ownerPath ? data.aspects : (data.typeCoverage?.applied ?? []);
  const aspect = aspects.find((a) => a.aspectId === aspectId);
  if (!aspect) return undefined;

  const lines: string[] = [];
  const status = aspect.status ?? 'enforced';
  const caveat = aspect.unverified ? ', unverified' : '';
  lines.push(`${aspect.aspectId} [${status}${caveat}] — ${aspect.aspectDescription}`);
  // A draft rule has no reviewer and no verdict — stop after the description
  // rather than pointing at a rule source nothing is judged against, mirroring
  // the compact view's draft notice.
  if (status === 'draft') {
    lines.push('    (reviewer skipped; aspect is draft)');
    return lines.join('\n');
  }
  lines.push(`read: ${posixPath(aspect.verifiedAgainst)}`);
  if (aspect.references) {
    for (const ref of aspect.references) {
      if (ref.description && ref.description.length > 0) {
        lines.push(`read: ${posixPath(ref.path)} — ${truncateDescription(ref.description)}`);
      } else {
        lines.push(`read: ${posixPath(ref.path)}`);
      }
    }
  }
  if (aspect.companionReadPath) {
    lines.push(`read: ${posixPath(aspect.companionReadPath)}`);
  }
  return lines.join('\n');
}
