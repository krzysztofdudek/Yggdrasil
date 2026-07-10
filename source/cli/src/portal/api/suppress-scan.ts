import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { scanSuppressionMarkers, scanSuppressionMarkersInComments } from '../../ast/suppress.js';
import type { SuppressionMarkerInfo } from '../../ast/suppress.js';
import { withParsedFile } from '../../ast/parser.js';
import { getLanguageForExtension } from '../../core/graph/language-registry.js';
import { buildIssueMessage } from '../../formatters/message-builder.js';
import { toPosixPath } from '../../utils/posix.js';
import { debugWrite } from '../../utils/debug-log.js';
import { isNoiseFile, isMappedSource } from './suppress-eligibility.js';
import type { SuppressionMarkerInput } from '../contract.js';

/**
 * portal/api/suppress-scan — the suppression scan, relocated here so the portal
 * facade OWNS it cleanly (it reaches the ast-adapter / language-registry / formatter)
 * and the `yg suppressions` command imports it from its source (command → facade).
 *
 * The scan logic is byte-for-byte the same one `yg suppressions` has always run, moved
 * verbatim from the command module — so the command's behavior and tests are unchanged.
 * `scanPortalSuppressions` adapts the report into the portal's flat marker shape (with a
 * resolved per-marker `risk` flag) for the live inventory.
 */

// ── Types ──────────────────────────────────────────────────

interface FileMarkers {
  file: string;
  markers: SuppressionMarkerInfo[];
}

export interface SuppressionsReport {
  fileEntries: FileMarkers[];
  totalMarkers: number;
  warnings: string[];
  /**
   * `"file:line"` keys of markers classified `file-level` — an UNCLOSED
   * `yg-suppress-disable` whose marker sits at the file head (first N non-empty
   * lines). This is the sanctioned whole-file waiver form: it is rendered
   * `file-level(<id>)` and does NOT get the "Unbounded range" warning. Optional so
   * legacy literal report constructions (tests) keep compiling; the real scan
   * always populates it (possibly empty).
   */
  fileLevelKeys?: Set<string>;
}

// ── Binary detection ───────────────────────────────────────

/**
 * Heuristic: treat a file as binary if it contains a NUL byte in the first
 * 8 KB. This matches git's own binary detection heuristic and avoids feeding
 * compiled artifacts or images to the text scanner.
 */
function isBinaryContent(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}


// ── Comment-aware marker scan ─────────────────────────────

/**
 * Scan one file for yg-suppress markers, restricted to REAL comments exactly as
 * the reviewer-honoring path does.
 *
 * - AST-parseable languages (a registered tree-sitter grammar): parse the file
 *   and scan only its COMMENT nodes. A `yg-suppress(...)` that appears inside a
 *   TypeScript string literal — e.g. a test fixture or a template that documents
 *   the marker syntax — is code, not a comment, so it is never inventoried. This
 *   matches `collectSuppressions`, the path the reviewer uses to actually waive
 *   an aspect, so the inventory lists exactly the waivers that can take effect.
 * - Non-AST languages (no registered grammar, e.g. `.sql`, `.sh`): there is no
 *   parse tree, so fall back to the language-agnostic raw-line scan. This
 *   preserves suppress support for content-only deterministic checks in those
 *   files (the `feat(suppress): honor yg-suppress markers in non-AST-language
 *   files` behavior).
 *
 * If a parseable file fails to parse (a syntax error or a grammar that cannot be
 * loaded), fall back to the raw-line scan rather than dropping the file from the
 * inventory — a best-effort inventory is better than a silent omission for a
 * read-only, exit-0 informational command.
 */
async function scanMarkersForFile(relFile: string, text: string): Promise<SuppressionMarkerInfo[]> {
  const ext = path.extname(relFile).toLowerCase();
  if (getLanguageForExtension(ext) === null) {
    // No registered grammar — raw-line scan (parity with the honoring path's
    // text fallback for non-AST languages). Pass relFile so the scan can mask
    // Markdown fenced-code examples out (same shared helper the honoring path uses).
    return scanSuppressionMarkers(text, relFile);
  }
  try {
    return await withParsedFile(relFile, text, (tree) =>
      // Pass the full source so the file-head window (atFileHead) is computed over
      // the real file lines — identically to the non-AST raw-line scan.
      scanSuppressionMarkersInComments(tree, relFile, text)
    );
  } catch (error) {
    debugWrite(`[suppressions] parse fallback (raw scan): ${relFile}: ${error instanceof Error ? error.message : String(error)}`);
    return scanSuppressionMarkers(text, relFile);
  }
}

// ── Core scan ─────────────────────────────────────────────

export async function runSuppressionsScan(
  projectRoot: string,
  gitTrackedFiles: string[],
  knownAspectIds: Set<string>,
  mappingEntries: string[] = [],
  underApproximatingAspectIds: Set<string> = new Set(),
): Promise<SuppressionsReport> {
  const fileEntries: FileMarkers[] = [];
  const warnings: string[] = [];
  let totalMarkers = 0;

  // Track unbounded disable markers per file (for open-range detection)
  // Map<file, Map<aspectId, disableLineNum[]>>
  const openDisables = new Map<string, Map<string, number[]>>();

  for (const relFile of gitTrackedFiles) {
    // Skip generated rules mirrors, per-node logs, and UNMAPPED prose docs — they
    // only MENTION the marker syntax and never carry a real, reviewer-honored
    // waiver. A MAPPED node source is exempt: the honoring path raw-scans any
    // mapped grammarless file, so a marker there is a LIVE waiver that MUST be
    // inventoried (parity — no silent waiver site).
    if (!isMappedSource(relFile, mappingEntries) && isNoiseFile(relFile)) continue;

    const absFile = path.join(projectRoot, relFile);
    if (!existsSync(absFile)) continue;

    let buf: Buffer;
    try {
      buf = readFileSync(absFile);
    } catch (error) {
      debugWrite(`[suppressions] read fallback: ${relFile}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (isBinaryContent(buf)) continue;

    const text = buf.toString('utf-8');
    const markers = await scanMarkersForFile(relFile, text);
    if (markers.length === 0) continue;

    fileEntries.push({ file: toPosixPath(relFile), markers });
    totalMarkers += markers.length;

    // Collect disable/enable pairs to detect unbounded ranges
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
    // Any aspects still in disableStack have unbounded ranges
    if (disableStack.size > 0) {
      openDisables.set(toPosixPath(relFile), disableStack);
    }
  }

  // ── File-level classification (RZ-12) ──────────────────
  //
  // An UNCLOSED disable whose marker sits at the file head (first N non-empty
  // lines, per the shared scanner's `atFileHead`) is the sanctioned whole-file
  // waiver: classify it `file-level` — rendered as such and NOT warned
  // "Unbounded". Reuse the open-disable set built above so the disable/enable
  // pairing stays in exactly one place; a later unclosed disable stays unbounded.
  const fileLevelKeys = new Set<string>();
  for (const { file, markers } of fileEntries) {
    const openForFile = openDisables.get(file);
    if (openForFile === undefined) continue;
    for (const m of markers) {
      if (m.kind === 'disable' && m.atFileHead && openForFile.get(m.aspectId)?.includes(m.line)) {
        fileLevelKeys.add(`${file}:${m.line}`);
      }
    }
  }

  // ── Generate warnings ──────────────────────────────────

  // Collect all unique (file, aspectId) combos for cross-checks
  const seenWildcard = new Set<string>(); // "file:line"

  for (const { file, markers } of fileEntries) {
    for (const m of markers) {
      // (a) Unknown aspect id — wildcard '*' is exempt
      if (!m.wildcard && !knownAspectIds.has(m.aspectId)) {
        const msg = buildIssueMessage({
          what: `Unknown aspect id "${m.aspectId}" in suppress marker at ${file}:${m.line}.`,
          why: 'The aspect does not exist in the graph. The suppression has no effect and likely refers to a renamed or deleted aspect.',
          next: `Run \`yg aspects\` to list defined aspect ids, then update or remove this marker.`,
        });
        warnings.push(msg);
      }

      // (b) Wildcard '*' usage
      if (m.wildcard && !seenWildcard.has(`${file}:${m.line}`)) {
        seenWildcard.add(`${file}:${m.line}`);
        const msg = buildIssueMessage({
          what: `Wildcard suppression "*" at ${file}:${m.line} silences ALL aspects.`,
          why: 'A wildcard suppresses every current and future aspect check on the affected code — including ones not yet written. This masks problems broadly and is hard to audit.',
          next: `Replace "*" with the specific aspect id(s) you intend to suppress.`,
        });
        warnings.push(msg);
      }

      // (d) Waiver on an under-approximating check (errs: under). Such a check
      // produces no false positives by design — it only fires on provable
      // violations — so waiving it is a footgun. `enable` is a range terminator,
      // not a waiver, and a wildcard is already covered by (b), so skip both.
      if (!m.wildcard && m.kind !== 'enable' && underApproximatingAspectIds.has(m.aspectId)) {
        const msg = buildIssueMessage({
          what: `yg-suppress(${m.aspectId}) at ${file}:${m.line} waives a check labeled errs: under.`,
          why: 'suppress targets an under-approximating check — such checks produce no false positives by design; either the errs label is wrong or this code path deserves a second look.',
          next: `Remove the waiver and re-examine the flagged code, or correct the aspect's errs label if 'under' is inaccurate.`,
        });
        warnings.push(msg);
      }
    }
  }

  // (c) Unbounded disable (no matching enable in same file). A file-head unclosed
  // disable is the sanctioned whole-file waiver (`file-level`) — classified, not
  // warned; only a LATER unclosed disable keeps the unbounded warning.
  for (const [file, disableMap] of openDisables) {
    for (const [aspectId, lines] of disableMap) {
      for (const lineNum of lines) {
        if (fileLevelKeys.has(`${file}:${lineNum}`)) continue;
        const msg = buildIssueMessage({
          what: `Unbounded yg-suppress-disable("${aspectId}") at ${file}:${lineNum} has no matching yg-suppress-enable.`,
          why: 'Without a closing enable marker the suppression covers the rest of the file, which is almost always broader than intended and hides future violations added below this line.',
          next: `Add \`yg-suppress-enable(${aspectId})\` at the end of the suppressed block, or convert to a single-line \`yg-suppress(${aspectId}) <reason>\` if only one line needs suppression.`,
        });
        warnings.push(msg);
      }
    }
  }

  return { fileEntries, totalMarkers, warnings, fileLevelKeys };
}

// ── Output formatting ─────────────────────────────────────

export function formatSuppressionsOutput(report: SuppressionsReport): string {
  const lines: string[] = [];

  if (report.fileEntries.length === 0) {
    lines.push('No active suppression markers found.');
    return lines.join('\n') + '\n';
  }

  // Inventory section
  lines.push('Active suppression markers:');
  lines.push('');

  for (const { file, markers } of report.fileEntries) {
    lines.push(`  ${file}`);
    for (const m of markers) {
      const wildcardTag = m.wildcard ? chalk.yellow(' [wildcard]') : '';
      // A file-head unclosed disable renders as the sanctioned whole-file form.
      const isFileLevel = report.fileLevelKeys?.has(`${file}:${m.line}`) ?? false;
      const kindTag = isFileLevel ? 'file-level' : m.kind === 'single' ? 'single' : m.kind === 'disable' ? 'disable' : 'enable';
      const reasonPart = m.reason ? `  — ${m.reason}` : '';
      lines.push(`    line ${m.line}: ${kindTag}(${m.aspectId})${wildcardTag}${reasonPart}`);
    }
    lines.push('');
  }

  // Tally
  const fileCount = report.fileEntries.length;
  lines.push(`Total: ${report.totalMarkers} marker${report.totalMarkers === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}.`);

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(chalk.yellow(`Warnings (${report.warnings.length}):`));
    for (const w of report.warnings) {
      // Indent each line of the warning message
      const indented = w.split('\n').map(l => `  ${l}`).join('\n');
      lines.push(chalk.yellow(indented));
    }
  }

  return lines.join('\n') + '\n';
}

// ── Portal adaptation ─────────────────────────────────────

/**
 * Adapt the suppression report into the portal's flat marker shape, resolving each
 * marker's `risk` flag. Only the genuine, reviewer-honored waiver KINDS are inventoried
 * (`single` and `disable` — the markers that actually silence a check); `enable` markers
 * are range terminators, not waivers, so they are not surfaced as inventory entries.
 *
 * Risk resolution (first match wins, most-severe first):
 *   - wildcard  — a `*` marker (silences every aspect, present and future).
 *   - typo      — names an aspect id absent from the graph (no effect; likely a rename).
 *   - inert     — names a DRAFT aspect (the reviewer never runs there, so the waiver is a no-op).
 *   - unbounded — a `disable` with no matching `enable` in the same file (open range).
 */
export function scanPortalSuppressions(
  report: SuppressionsReport,
  knownAspectIds: Set<string>,
  draftAspectIds: Set<string>,
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
      const risk = resolveRisk(m, file, open, knownAspectIds, draftAspectIds);
      out.push({
        file,
        line: m.line,
        aspectId: m.aspectId,
        reason: m.reason,
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
): SuppressionMarkerInput['risk'] | undefined {
  if (m.wildcard) return 'wildcard';
  if (!knownAspectIds.has(m.aspectId)) return 'typo';
  if (draftAspectIds.has(m.aspectId)) return 'inert';
  if (m.kind === 'disable' && openLines?.has(m.line)) return 'unbounded';
  return undefined;
}
