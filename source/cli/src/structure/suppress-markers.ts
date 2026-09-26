/**
 * The comment-aware scan of one file's `yg-suppress` markers — the parsing half
 * of the suppression scan the engine runs. It lives beside the honoring path
 * (suppress-ranges), in the layer that may parse code: the engine asks it for a
 * file's markers and never reaches the parser itself, so the inventory and the
 * honoring path read markers the same way.
 */
import path from 'node:path';
import { scanSuppressionMarkers, scanSuppressionMarkersInComments } from '../ast/suppress.js';
import type { SuppressionMarkerInfo } from '../ast/suppress.js';
import { withParsedFile } from '../ast/parser.js';
import { getLanguageForExtension } from '../utils/language-registry.js';
import { debugWrite } from '../utils/debug-log.js';

export type { SuppressionMarkerInfo };

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
export async function scanMarkersForFile(relFile: string, text: string): Promise<SuppressionMarkerInfo[]> {
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
