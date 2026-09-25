import path from 'node:path';
import { scanMarkersForFile, type SuppressionMarkerInfo } from '../../structure/suppress-markers.js';
import { readFileBytes } from '../../io/graph-fs.js';
import type { IssueMessage } from '../../model/validation.js';
import { toPosixPath } from '../../utils/posix.js';
import { debugWrite } from '../../utils/debug-log.js';
import { isNoiseFile, isMappedSource, isTypeCoveredSource, computeSuppressionScanUniverse, collectMappingEntries } from './eligibility.js';
import { NO_COVERAGE_EXCLUDED } from '../../io/repo-scanner.js';
import type { CoverageConfig, Graph } from '../../model/graph.js';

export type { SuppressionMarkerInfo };

/**
 * core/suppressions/scan — the one scan of `yg-suppress` markers every surface
 * reads: the `yg suppressions` inventory, rule health, the attention layer, the
 * portal's live inventory, and the reason-less marker warning `yg check` and
 * the portal report alike (runCheck takes this scan's reason-less markers as an
 * injected input, so both surfaces state the same finding).
 *
 * It returns data: each warning as a structured what / why / next, which the
 * command layer renders, and which the portal adapts into its own marker shape.
 * Files are read through the io layer and parsed through the structure layer
 * (beside the honoring path's own parse); a file that cannot be read is
 * skipped, never fatal.
 */

// ── Types ──────────────────────────────────────────────────

interface FileMarkers {
  file: string;
  markers: SuppressionMarkerInfo[];
}

export interface SuppressionsReport {
  fileEntries: FileMarkers[];
  totalMarkers: number;
  /**
   * `"file:line"` keys of markers classified `file-level` — an UNCLOSED
   * `yg-suppress-disable` whose marker sits at the file head (first N non-empty
   * lines). This is the sanctioned whole-file waiver form: it is rendered
   * `file-level(<id>)` and does NOT get the "Unbounded range" warning. Optional so
   * legacy literal report constructions (tests) keep compiling; the real scan
   * always populates it (possibly empty).
   */
  fileLevelKeys?: Set<string>;
  /**
   * Per-`disable`-marker span, one entry per `disable` (never per `single` or
   * `enable`). A CLOSED pair carries the matching `yg-suppress-enable`'s line as
   * `to`; an UNCLOSED (open, including file-level) disable carries `to: null`.
   * Nested same-aspect disables pair LIFO — closing binds to the most recently
   * opened one, exactly like the unbounded-detection stack below already
   * assumes, so this adds no new pairing rule. Optional for the same reason
   * `fileLevelKeys` is: legacy literal report constructions (tests) keep
   * compiling; the real scan always populates it (possibly empty).
   */
  ranges?: Array<{ file: string; aspect: string; from: number; to: number | null }>;
  /**
   * One entry per warning, in scan order: the finding as a structured what /
   * why / next (the formatters render it) plus the structured facts a machine
   * consumer needs. `aspect` is the specific
   * aspect id the warning is about, except for `wildcard`: that warning is about
   * the marker silencing every aspect, not any one of them, so its `aspect` is
   * `null`. Optional for the same reason `fileLevelKeys` is.
   */
  warningRecords?: Array<{
    code: 'unknown-aspect' | 'wildcard' | 'unbounded-range' | 'waives-under' | 'missing-reason';
    file: string;
    line: number;
    aspect: string | null;
    messageData: IssueMessage;
  }>;
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


/**
 * The finding for a `yg-suppress` marker with no reason — shared by the
 * `yg suppressions` inventory and the warning `yg check` raises for the same
 * marker, so the two surfaces word it identically.
 */
export function reasonlessMarkerMessage(file: string, line: number, aspect: string): IssueMessage {
  return {
    what: `yg-suppress marker at ${file}:${line} has no reason.`,
    why: 'A reason is required. A marker without one waives nothing: as soon as the check flags a line it covers, the fill rejects the marker (malformed-suppress-marker) and leaves the pair unverified — until then nothing else reports it.',
    next: `Add the reason after the marker in ${file}:${line} (\`yg-suppress(${aspect}) <why this is acceptable>\`) and ask the user to approve it first, or remove the marker.`,
  };
}

// ── Core scan ─────────────────────────────────────────────

export async function runSuppressionsScan(
  projectRoot: string,
  walkedFiles: string[],
  knownAspectIds: Set<string>,
  mappingEntries: string[] = [],
  underApproximatingAspectIds: Set<string> = new Set(),
  typeCoveredFiles: Set<string> = new Set(),
  coverage: CoverageConfig = NO_COVERAGE_EXCLUDED,
): Promise<SuppressionsReport> {
  const fileEntries: FileMarkers[] = [];
  const ranges: NonNullable<SuppressionsReport['ranges']> = [];
  const warningRecords: NonNullable<SuppressionsReport['warningRecords']> = [];
  let totalMarkers = 0;

  // Track unbounded disable markers per file (for open-range detection)
  // Map<file, Map<aspectId, disableLineNum[]>>
  const openDisables = new Map<string, Map<string, number[]>>();

  // `walkedFiles` is an ordinary repo walk — it answers "what needs
  // coverage", not "what file can a live marker be on". Widen it to the
  // scan's real candidate universe (see `computeSuppressionScanUniverse`'s
  // own comment for exactly what that adds and why) before the noise filter
  // below ever runs, so a mapped file the walk cannot see is never silently
  // dropped before it gets a chance to be recognized as a live waiver site.
  const scanFiles = await computeSuppressionScanUniverse(projectRoot, walkedFiles, mappingEntries, coverage);

  for (const relFile of scanFiles) {
    // Skip generated rules mirrors, per-node logs, and prose docs that carry no
    // live waiver — they only MENTION the marker syntax. A file that IS a live
    // waiver site is exempt from that noise filter regardless of extension: a
    // MAPPED node source (the honoring path raw-scans any mapped grammarless
    // file) or a TYPE-COVERED file (the type-level classification lattice's
    // `covered` bucket — a file enforced by its architecture type alone runs
    // that type's aspects exactly like a mapped source runs its node's). Either
    // way a marker there is a LIVE waiver that MUST be inventoried (parity — no
    // silent waiver site).
    if (
      !isMappedSource(relFile, mappingEntries) &&
      !isTypeCoveredSource(relFile, typeCoveredFiles) &&
      isNoiseFile(relFile)
    ) continue;

    const absFile = path.join(projectRoot, relFile);
    // A file that vanished or cannot be read carries no marker this scan can see.
    const buf = await readFileBytes(absFile);
    if (buf === null) {
      debugWrite(`[suppressions] skipped, not readable: ${relFile}`);
      continue;
    }

    if (isBinaryContent(buf)) continue;

    const text = buf.toString('utf-8');
    // Every marker form contains this token, so a file without it has none —
    // skip the parse. This is what keeps the scan cheap enough for `yg check`
    // to run it on every mapped source.
    if (!text.includes('yg-suppress')) continue;
    const markers = await scanMarkersForFile(relFile, text);
    if (markers.length === 0) continue;

    fileEntries.push({ file: toPosixPath(relFile), markers });
    totalMarkers += markers.length;

    // Collect disable/enable pairs to detect unbounded ranges, and record
    // every disable's own span into `ranges` (closed now, or open below).
    const disableStack = new Map<string, number[]>();
    for (const m of markers) {
      if (m.kind === 'disable') {
        const stack = disableStack.get(m.aspectId) ?? [];
        stack.push(m.line);
        disableStack.set(m.aspectId, stack);
      } else if (m.kind === 'enable') {
        const stack = disableStack.get(m.aspectId);
        if (stack && stack.length > 0) {
          const from = stack.pop() as number;
          ranges.push({ file: toPosixPath(relFile), aspect: m.aspectId, from, to: m.line });
          if (stack.length === 0) disableStack.delete(m.aspectId);
        }
      }
    }
    // Any aspects still in disableStack have unbounded ranges — record each as
    // an open span (`to: null`) before the stack is (possibly) carried forward
    // into openDisables for the unbounded-warning / file-level pass below.
    if (disableStack.size > 0) {
      for (const [aspectId, lines] of disableStack) {
        for (const line of lines) {
          ranges.push({ file: toPosixPath(relFile), aspect: aspectId, from: line, to: null });
        }
      }
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
  const seenReasonless = new Set<string>(); // "file:line"

  for (const { file, markers } of fileEntries) {
    for (const m of markers) {
      // (a) Unknown aspect id — wildcard '*' is exempt
      if (!m.wildcard && !knownAspectIds.has(m.aspectId)) {
        const msg: IssueMessage = {
          what: `Unknown aspect id "${m.aspectId}" in suppress marker at ${file}:${m.line}.`,
          why: 'The aspect does not exist in the graph. The suppression has no effect and likely refers to a renamed or deleted aspect.',
          next: `Run \`yg aspects\` to list defined aspect ids, then update or remove this marker.`,
        };
        warningRecords.push({ code: 'unknown-aspect', file, line: m.line, aspect: m.aspectId, messageData: msg });
      }

      // (b) Wildcard '*' usage
      if (m.wildcard && !seenWildcard.has(`${file}:${m.line}`)) {
        seenWildcard.add(`${file}:${m.line}`);
        const msg: IssueMessage = {
          what: `Wildcard suppression "*" at ${file}:${m.line} silences ALL aspects.`,
          why: 'A wildcard suppresses every current and future aspect check on the affected code — including ones not yet written. This masks problems broadly and is hard to audit.',
          next: `Replace "*" with the specific aspect ids you intend to suppress.`,
        };
        // No single aspect this warning is "about" — it is about the marker
        // silencing every aspect, present and future — so `aspect` is null.
        warningRecords.push({ code: 'wildcard', file, line: m.line, aspect: null, messageData: msg });
      }

      // (d) Waiver on an under-approximating check (errs: under). Such a check
      // produces no false positives by design — it only fires on provable
      // violations — so waiving it is a footgun. `enable` is a range terminator,
      // not a waiver, and a wildcard is already covered by (b), so skip both.
      if (!m.wildcard && m.kind !== 'enable' && underApproximatingAspectIds.has(m.aspectId)) {
        const msg: IssueMessage = {
          what: `yg-suppress(${m.aspectId}) at ${file}:${m.line} waives a check labeled errs: under.`,
          why: 'suppress targets an under-approximating check — such checks produce no false positives by design; either the errs label is wrong or this code path deserves a second look.',
          next: `Remove the waiver and re-examine the flagged code, or correct the aspect's errs label if 'under' is inaccurate.`,
        };
        warningRecords.push({ code: 'waives-under', file, line: m.line, aspect: m.aspectId, messageData: msg });
      }

      // (e) A waiver with no reason. It suppresses nothing: the first time the
      // check flags a line in its range, the fill refuses the marker itself and
      // leaves the pair unverified. Until then it passes every check silently,
      // so this is the one place the defect shows up when the marker is written.
      // `enable` closes a range and carries no reason of its own.
      // One warning per marker line: a marker naming several aspects is
      // scanned as one entry per aspect, but it lacks one reason, not several.
      if (m.kind !== 'enable' && m.reason.trim() === '' && !seenReasonless.has(`${file}:${m.line}`)) {
        seenReasonless.add(`${file}:${m.line}`);
        const msg = reasonlessMarkerMessage(file, m.line, m.wildcard ? '*' : m.aspectId);
        warningRecords.push({ code: 'missing-reason', file, line: m.line, aspect: m.wildcard ? null : m.aspectId, messageData: msg });
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
        const msg: IssueMessage = {
          what: `Unbounded yg-suppress-disable("${aspectId}") at ${file}:${lineNum} has no matching yg-suppress-enable.`,
          why: 'Without a closing enable marker the suppression covers the rest of the file, which is almost always broader than intended and hides future violations added below this line.',
          next: `Add \`yg-suppress-enable(${aspectId})\` at the end of the suppressed block, or convert to a single-line \`yg-suppress(${aspectId}) <reason>\` if only one line needs suppression.`,
        };
        warningRecords.push({ code: 'unbounded-range', file, line: lineNum, aspect: aspectId, messageData: msg });
      }
    }
  }

  return { fileEntries, totalMarkers, fileLevelKeys, ranges, warningRecords };
}

// ── Reason-less markers, for the check ────────────────────

/** A `yg-suppress` marker with no reason, as runCheck takes it: where it is, and the finding worded. */
export interface ReasonlessMarker {
  file: string;
  line: number;
  messageData: IssueMessage;
}

/**
 * Every marker in a mapped source that carries no reason — the input runCheck
 * turns into its `suppress-marker-missing-reason` warnings. Such a marker
 * waives nothing and nothing else notices it: the check passes until the day a
 * violation lands in its range, and only then does the fill reject the marker
 * and leave the pair unverified. Scanned here, once, by whichever surface is
 * about to report a check, so the command line and the portal state the same
 * finding. Limited to mapped sources (the only files a marker can waive in),
 * and a file without the marker token is skipped unparsed, so it costs one read
 * of each mapped file and nothing more. Best effort: a scan that fails reports
 * nothing rather than failing the check.
 */
export async function scanReasonlessMarkers(graph: Graph, projectRoot: string, repoFiles: string[]): Promise<ReasonlessMarker[]> {
  try {
    const mappingEntries = collectMappingEntries(graph);
    if (mappingEntries.length === 0) return [];
    const report = await runSuppressionsScan(
      projectRoot,
      repoFiles.filter((f) => isMappedSource(f, mappingEntries)),
      new Set(graph.aspects.map((a) => a.id)),
      mappingEntries,
      new Set(),
      new Set(),
      graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
    );
    return (report.warningRecords ?? [])
      .filter((w) => w.code === 'missing-reason')
      .map((w) => ({ file: w.file, line: w.line, messageData: w.messageData }));
  } catch (error) {
    debugWrite(`[suppressions] reason-less marker scan skipped: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
