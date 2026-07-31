// Reviewer prompt assembly — per-node and per-file scaffold variants.
import type { ScopeDef } from '../model/graph.js';
import { escapeXmlText } from './xml-escape.js';

/**
 * The reviewer-prompt template regime marker. Recorded on each LLM verdict
 * event emitted by the fill's telemetry sidecar (io/events-store.ts) so a
 * future rule-health report can tell which prompt scaffold produced a given
 * verdict. The revision names prompt-scaffold SHAPES a real recorded event
 * could actually carry — so it advances only when a shape that has already
 * shipped in a release changes (section order, framing sentences, XML
 * structure). It does NOT advance for: aspect content changes, which already
 * invalidate verdicts through the lock's own hash; or a further edit to a
 * shape that has never shipped — revising an unreleased shape in place keeps
 * its current number, since bumping would claim a public shape that never
 * existed for anyone to have recorded an event against.
 *
 * Bumped 1 -> 2: the nodeless variant (a file enforced by its architecture
 * type alone, with no owning component) omits the <node> element and swaps
 * the component-framing sentence for a single-file one — different bytes for
 * a unit kind revision 1 never described. Not a hash ingredient (verified:
 * this constant appears only here and at its four consumer sites, never in
 * pair-hash.ts), so no stored verdict is invalidated by the bump — it only
 * keeps the record honest about which shape produced a given nodeless verdict.
 * Rev 2's own nodeless framing sentence was revised again before rev 2 ever
 * shipped in a release — that revision stays rev 2, not rev 3: no released
 * build ever recorded an event against the earlier wording, so there is no
 * shipped shape for a new number to distinguish it from.
 */
export const PROMPT_FORMAT_REV = 2;

/**
 * Default prompt-size limit applied when a tier OMITS `max_prompt_chars`.
 * A hand-authored tier that leaves the key out is gated at this cap (the §4
 * size gate is always active); only an explicit positive integer overrides it.
 * `yg init` writes 50000 explicitly, so this default only affects hand-authored
 * tiers that omit the key. Excluded from the tier hash (`pair-inputs.ts`), so
 * applying it re-rolls no verdict.
 */
export const DEFAULT_MAX_PROMPT_CHARS = 50000;

export interface PromptAspectInput { id: string; description: string; content: string }
export interface PromptReferenceInput { path: string; description?: string; content: string }
export interface PromptFileInput { path: string; content: string }
export interface PromptCompanionInput { path: string; content: string; label?: string }
/**
 * Pre-resolved suppress line ranges injected into the reviewer prompt so the LLM
 * honors EXACTLY the same `(file, startLine..endLine)` spans the deterministic
 * matcher (`ast/suppress.ts`) computes — no model-side re-derivation of marker
 * scope. `byFile` carries only files that have at least one applicable range;
 * an empty `byFile` (or an omitted `suppressedRanges`) renders no block and keeps
 * the prompt byte-identical to the no-suppress case.
 */
export interface PromptSuppressedRangesInput {
  byFile: Array<{ path: string; ranges: Array<{ startLine: number; endLine: number }> }>;
}
export interface PairPromptInput {
  aspect: PromptAspectInput;
  references: PromptReferenceInput[];
  /**
   * Omitted for a nodeless (type-covered-file) pair — there is no component to
   * name. When absent, the `<node .../>` element is omitted ENTIRELY (no
   * element, no blank line where it was) and the top framing sentence swaps
   * from "a node (component)" to a single-file sentence — there is nothing
   * true to say about a component that does not exist, and naming one would
   * mislead the reviewer. A component pair's rendering (nodePath defined) is
   * byte-identical to before this variant existed.
   */
  nodePath?: string;
  /** Omitted together with nodePath — there is no component description to show. */
  nodeDescription?: string;
  files: PromptFileInput[];           // per-node: whole subject set; per-file: exactly one
  companions?: PromptCompanionInput[];   // resolved per-unit by companion.mjs; absent for plain aspects
  suppressedRanges?: PromptSuppressedRangesInput; // pre-resolved per-file suppress spans; absent ≙ no waivers
  scope: ScopeDef | undefined;        // undefined ≙ {per:'node'}
}

/** The single-file framing sentence added when scope.per === 'file' AND the unit has an owning component (nodePath is defined). */
const PER_FILE_FRAMING =
  `You are reviewing ONE file of a larger component. Other files of the component are not shown; the absence of sibling context is NOT a violation by itself. Judge only what this file must satisfy on its own.`;

/**
 * The single-file framing sentence for scope.per === 'file' on a unit with NO
 * owning component (a file enforced by its architecture type alone).
 * PER_FILE_FRAMING's "of a larger component" claim is false here — there is
 * no component, and the prompt's own intro sentence (built from `hasNode`
 * just below) already says so ("a single source file", never "a node
 * (component)").
 *
 * The claim this sentence makes must stay scoped to the COMPONENT, exactly
 * like PER_FILE_FRAMING's own "other files of the component are not shown" —
 * never widened to a claim about the whole prompt. A nodeless unit can still
 * carry a `<references>` and/or a `<companions>` block with full file bodies
 * (both render unconditionally, independent of nodePath); asserting "no other
 * files are shown" would be false the moment either renders, and would read
 * as an instruction to disregard evidence the reviewer is looking at in the
 * same prompt. What IS true regardless: there is no component, so there are
 * no component-sibling files to show, and whatever references or companions
 * this prompt DOES include are the entire extent of that context — nothing
 * is being withheld beyond what is rendered. The operative leniency guard
 * (having none of that beyond the file itself is not itself a violation)
 * carries over unchanged.
 */
const PER_FILE_FRAMING_NODELESS =
  `You are reviewing this file on its own. It has no owning component, so there are no component siblings to show; any references or companions this prompt includes are the entire extent of that context, and having none beyond the file itself is NOT a violation by itself. Judge only what this file must satisfy on its own.`;

/**
 * Assembles the reviewer prompt. Per-node output is BYTE-IDENTICAL to the legacy
 * buildPrompt for equivalent inputs (golden-pinned). Per-file adds the single-file framing.
 *
 * Contract for callers: with scope.per === 'file', callers MUST pass exactly one file in
 * `input.files`. Passing multiple files would contradict the single-file framing sentence
 * added by this function — the reviewer would see "you are reviewing ONE file" while
 * receiving several. Enforcing this constraint is the caller's responsibility.
 */
export function buildPairPrompt(input: PairPromptInput): string {
  const { aspect, references, nodePath, nodeDescription, files, companions, suppressedRanges, scope } = input;

  const isPerFile = scope?.per === 'file';

  // Escape adopter-controlled interpolations so source content cannot break out
  // of the XML framing or inject markup into the reviewer prompt — matching the
  // references block, which is already escaped. The `path` is an attribute; the
  // file body is text. (The aspect rule body below stays raw: it is the trusted
  // instruction the reviewer must read verbatim.)
  const filesBlock = files.map(f =>
    `<file path="${escapeXmlText(f.path, { attribute: true })}">\n${escapeXmlText(f.content, { attribute: false })}\n</file>`
  ).join('\n\n');

  const referencesBlock = references.length === 0 ? '' : `

<references>
${references.map(r => {
  const descAttr = r.description ? ` description="${escapeXmlText(r.description, { attribute: true })}"` : '';
  return `  <reference path="${escapeXmlText(r.path, { attribute: true })}"${descAttr}>
${escapeXmlText(r.content, { attribute: false })}
  </reference>`;
}).join('\n')}
</references>`;

  const sortedCompanions = [...(companions ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const companionsBlock = sortedCompanions.length === 0 ? '' : `

These are the subject's resolved paired file(s) — read-only context, not the unit under judgment:
<companions>
${sortedCompanions.map(c => {
  const labelAttr = c.label ? ` label="${escapeXmlText(c.label, { attribute: true })}"` : '';
  return `  <companion path="${escapeXmlText(c.path, { attribute: true })}"${labelAttr}>
${escapeXmlText(c.content, { attribute: false })}
  </companion>`;
}).join('\n')}
</companions>`;

  const hasNode = nodePath !== undefined;
  // The per-file framing paragraph is gated on hasNode the same way the intro
  // sentence and <node> element below are: a componented unit gets the
  // "larger component" framing, a nodeless unit gets the honest variant that
  // says nothing about a component that does not exist.
  const perFileParagraph = isPerFile ? `\n${hasNode ? PER_FILE_FRAMING : PER_FILE_FRAMING_NODELESS}\n` : '';

  // The top framing sentence names a node (component) only when one exists.
  // For a nodeless unit (a file enforced by its architecture type alone)
  // there is nothing true to say about a component that does not exist, so
  // the sentence is about the single source file instead — never "node" or
  // "component".
  const introSentence = hasNode
    ? 'Below is a node (component) with its source files and one aspect (rule set).'
    : 'Below is a single source file with its content and one aspect (rule set).';
  // The <node .../> element itself is omitted entirely when there is no
  // component — no element, no blank line where it was (the template below
  // interpolates this directly after </task>, so an empty string collapses
  // the two blank lines around it into exactly one).
  const nodeElement = hasNode
    ? `\n\n<node path="${escapeXmlText(nodePath, { attribute: true })}" description="${escapeXmlText(nodeDescription ?? '', { attribute: true })}" />`
    : '';

  // Pre-resolved suppress spans (computed deterministically from yg-suppress
  // markers by ast/suppress.ts). Only files with at least one applicable range
  // appear. Rendering this block — and the instruction below — is gated on there
  // being at least one range, so the prompt stays byte-identical to the
  // no-suppress case when there are none (golden-pinned).
  const suppressedFiles = (suppressedRanges?.byFile ?? []).filter(f => f.ranges.length > 0);
  const suppressedRangesBlock = suppressedFiles.length === 0 ? '' : `

<suppressed-ranges>
${suppressedFiles.map(f =>
  `  <file path="${escapeXmlText(f.path, { attribute: true })}">
${f.ranges.map(r => `    <range start-line="${r.startLine}" end-line="${r.endLine}" />`).join('\n')}
  </file>`
).join('\n')}
</suppressed-ranges>`;

  return `<task>
You verify whether source code satisfies a requirement.

${introSentence}
Check every rule in the aspect against the source code.

A yg-suppress marker in a comment waives this aspect for specific lines. Those lines
have already been resolved for you and are listed in <suppressed-ranges> below, as
exact (start-line, end-line) spans into the files in <source-files>. Treat every line
inside a listed span as satisfied — do NOT report a violation on any line covered by a
span, even if the code there clearly breaks the rule. Honor exactly these line ranges:
do NOT re-derive the marker's scope yourself (do NOT expand it to the surrounding
function, class, block, or whole file, and do NOT shrink it). If <suppressed-ranges> is
absent or lists nothing for a file, no lines in that file are waived. Do not validate
the reason text on a marker — the spans are authoritative.
${perFileParagraph}
Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation with file:line references"}
</task>${nodeElement}

<aspect id="${escapeXmlText(aspect.id, { attribute: true })}" description="${escapeXmlText(aspect.description, { attribute: true })}">
${aspect.content}
</aspect>${referencesBlock}${companionsBlock}${suppressedRangesBlock}

<source-files>
${filesBlock}
</source-files>`;
}

/** Gate-canonical prompt: companions rendered WITHOUT labels (verify cannot reconstruct labels). The §4 gate measures THIS. */
export function assembledPromptChars(input: PairPromptInput): number {
  const gateCompanions = (input.companions ?? []).map((c) => ({ path: c.path, content: c.content }));
  return buildPairPrompt({ ...input, companions: gateCompanions }).length;
}
