/**
 * source/cli/src/structure/suppress-ranges.ts — resolves yg-suppress line ranges
 * for the LLM reviewer prompt.
 *
 * The LLM and deterministic suppress paths must waive the SAME `(file, line)`
 * spans. The deterministic runners already compute spans via `ast/suppress.ts`;
 * this helper computes the identical spans for the LLM path and shapes them as
 * a `PromptSuppressedRangesInput` the prompt assembler injects verbatim.
 *
 * ARCHITECTURE ROUTING: the engine node `cli/core/fill` (and the
 * `cli/commands/aspect-test` command) call THIS structure helper instead of
 * importing `ast/*` directly. The architecture forbids `engine → ast-adapter`,
 * but allows `engine → structure-adapter` and `structure-adapter → ast-adapter`,
 * so this module is the legal bridge: it may import `ast/parser` and
 * `ast/suppress`; its callers may not.
 */
import { extname } from 'node:path';
import { withParsedFile } from '../ast/parser.js';
import { collectSuppressions, formatSuppressedRangesForAspect } from '../ast/suppress.js';
import { getLanguageForExtension } from '../utils/language-registry.js';
import type { PromptSuppressedRangesInput } from '../llm/prompt.js';

// Re-export so the engine/command callers (which may NOT import ast/* directly)
// can `instanceof`-check the reasonless-marker error their fail-closed handling
// needs. This is a value re-export — SuppressMarkerError is a class.
export { SuppressMarkerError } from '../ast/suppress.js';

/**
 * Resolve, per subject file, the suppress line ranges that apply to `aspectId`,
 * shaped for injection into the reviewer prompt.
 *
 * Parse strategy mirrors the deterministic AST runner (`ast/runner.ts`): a file
 * whose extension has a registered tree-sitter grammar is parsed and its markers
 * read from comment nodes; a file with no grammar (`.sql`, `.md`, `.sh`, …) gets
 * a raw-line content scan. Either way `collectSuppressions` produces the spans
 * and `formatSuppressedRangesForAspect` filters them to this aspect (wildcard
 * markers included).
 *
 * Only files with at least one applicable range appear in `byFile`, so an empty
 * result renders no `<suppressed-ranges>` block and the prompt stays byte-identical
 * to the no-suppress case.
 *
 * A reasonless marker throws `SuppressMarkerError` (out of `collectSuppressions`)
 * — the caller treats that as an infrastructure failure and writes nothing, the
 * same fail-closed disposition the deterministic path takes.
 */
export async function resolveSuppressedRangesForPrompt(
  subjects: Array<{ path: string; bytes: Buffer }>,
  aspectId: string,
): Promise<PromptSuppressedRangesInput> {
  const byFile: PromptSuppressedRangesInput['byFile'] = [];
  for (const subject of subjects) {
    const content = subject.bytes.toString('utf8');
    const hasGrammar = getLanguageForExtension(extname(subject.path).toLowerCase()) !== null;
    const totalLines = content.split('\n').length;
    const all = hasGrammar
      ? await withParsedFile(subject.path, content, (tree) =>
          collectSuppressions(tree, subject.path, totalLines, content)
        )
      : collectSuppressions(undefined, subject.path, totalLines, content);
    const ranges = formatSuppressedRangesForAspect(all, aspectId);
    if (ranges.length > 0) {
      byFile.push({ path: subject.path, ranges });
    }
  }
  return { byFile };
}
