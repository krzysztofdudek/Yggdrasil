import type { SuppressionMarkerInfo } from '../../ast/suppress.js';
import type { SuppressionMarkerInput } from '../contract.js';
import type { SuppressionsReport } from './suppress-scan.js';

/**
 * portal/api/suppress-adapt — turns the raw suppression scan (suppress-scan.ts's
 * `SuppressionsReport`) into the portal's flat, risk-resolved marker shape. Split out of
 * suppress-scan.ts so that scan module stays within its file-size boundary, the same reason
 * suppress-coverage.ts was split out earlier; it lives in the same portal facade node as the
 * scan it adapts.
 */

/**
 * Adapt the suppression report into the portal's flat marker shape, resolving each
 * marker's `form` and `risk` flag. Only the genuine, reviewer-honored waiver KINDS are
 * inventoried (`single` and `disable` — the markers that actually silence a check);
 * `enable` markers are range terminators, not waivers, so they are not surfaced as
 * inventory entries.
 *
 * `form` — the waiver's scope shape, independent of `risk`:
 *   - 'line'  — a `single` marker (`yg-suppress(id) reason`), scoped to its own line.
 *   - 'file'  — a `disable` whose `file:line` key is in the report's `fileLevelKeys`
 *               (the file-head unclosed disable `yg suppressions` classifies `file-level`).
 *   - 'range' — any other `disable` (a bounded start/end block, or a later unclosed one
 *               that reads `risk: 'unbounded'` below).
 *
 * Risk resolution (first match wins, most-severe first: wildcard > typo > inert >
 * errs-under > unbounded):
 *   - wildcard   — a `*` marker (silences every aspect, present and future).
 *   - typo       — names an aspect id absent from the graph (no effect; likely a rename).
 *   - inert      — names a DRAFT aspect (the reviewer never runs there, so the waiver is a no-op).
 *   - errs-under — names an aspect declaring `errs: 'under'` (a deterministic check that
 *                  produces no false positives by design) — the waiver silences nothing
 *                  that could actually fire.
 *   - unbounded  — a `disable` with no matching `enable` in the same file (open range),
 *                  EXCEPT a file-head unclosed disable, which `yg suppressions` classifies
 *                  `file-level` (the sanctioned whole-file waiver): it is no-risk here too,
 *                  so the portal inventory and `yg suppressions` never disagree on it.
 *
 * `underApproximatingAspectIds` defaults to empty so an existing caller that only wants
 * form/wildcard/typo/inert/unbounded (e.g. `yg advise`'s own nomination scan, which
 * deliberately never surfaces the errs-under footgun) keeps compiling and behaving
 * unchanged.
 */
export function scanPortalSuppressions(
  report: SuppressionsReport,
  knownAspectIds: Set<string>,
  draftAspectIds: Set<string>,
  underApproximatingAspectIds: Set<string> = new Set(),
): SuppressionMarkerInput[] {
  // Re-derive open (unbounded) disable lines per file so each marker can be tagged.
  const unboundedByFile = new Map<string, Set<number>>();
  for (const { file, markers } of report.fileEntries) {
    const disableStack = new Map<string, number[]>();
    for (const m of markers) {
      if (m.kind === 'disable') {
        const stack = disableStack.get(m.aspectId) ?? [];
        stack.push(m.line);
        disableStack.set(m.aspectId, stack);
      } else if (m.kind === 'enable') {
        const stack = disableStack.get(m.aspectId);
        if (stack && stack.length > 0) {
          stack.pop();
          if (stack.length === 0) disableStack.delete(m.aspectId);
        }
      }
    }
    const open = new Set<number>();
    for (const lines of disableStack.values()) for (const l of lines) open.add(l);
    if (open.size > 0) unboundedByFile.set(file, open);
  }

  const out: SuppressionMarkerInput[] = [];
  for (const { file, markers } of report.fileEntries) {
    const open = unboundedByFile.get(file);
    for (const m of markers) {
      if (m.kind === 'enable') continue; // range terminator, not a waiver entry
      const risk = resolveRisk(m, file, open, knownAspectIds, draftAspectIds, report.fileLevelKeys, underApproximatingAspectIds);
      // form: single → 'line'; disable with fileLevelKeys hit → 'file'; other disable → 'range'
      const form: SuppressionMarkerInput['form'] =
        m.kind === 'single' ? 'line' : report.fileLevelKeys?.has(`${file}:${m.line}`) ? 'file' : 'range';
      out.push({
        file,
        line: m.line,
        aspectId: m.aspectId,
        reason: m.reason,
        form,
        ...(risk ? { risk } : {}),
      });
    }
  }
  return out;
}

function resolveRisk(
  m: SuppressionMarkerInfo,
  file: string,
  openLines: Set<number> | undefined,
  knownAspectIds: Set<string>,
  draftAspectIds: Set<string>,
  fileLevelKeys: Set<string> | undefined,
  underApproximatingAspectIds: Set<string>,
): SuppressionMarkerInput['risk'] | undefined {
  if (m.wildcard) return 'wildcard';
  if (!knownAspectIds.has(m.aspectId)) return 'typo';
  if (draftAspectIds.has(m.aspectId)) return 'inert';
  if (m.kind !== 'enable' && underApproximatingAspectIds.has(m.aspectId)) return 'errs-under';
  if (m.kind === 'disable' && openLines?.has(m.line)) {
    // A file-head unclosed disable is the sanctioned whole-file waiver: `yg suppressions`
    // classifies it `file-level` and does NOT warn "Unbounded". Honor the SAME signal
    // (the scan's `fileLevelKeys`, computed once from each marker's `atFileHead`) so the
    // portal inventory agrees with the CLI — such a marker is no-risk, never 'unbounded'.
    if (fileLevelKeys?.has(`${file}:${m.line}`)) return undefined;
    return 'unbounded';
  }
  return undefined;
}
