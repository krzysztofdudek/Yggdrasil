/**
 * The check's two standing notices — facts about how the project is set up,
 * printed as a `note:` line, never a finding. Words only; the check decides
 * when each applies and the report prints it.
 */

/**
 * Standing notice: coverage.type_level is on, but no type in the architecture
 * declares when:, so the classification lattice can never match a single
 * file (classifyFile skips every type without when — core/type-classifier.ts)
 * — the flag is committed but does nothing yet. Shared verbatim between yg
 * check's coverage-section render and yg init's closing summary so the same
 * fact reads identically on both surfaces.
 */
export const ZERO_CLASSIFYING_TYPES_NOTICE =
  "Type-level coverage is on, but no type in yg-architecture.yaml declares 'when:' — no file can be type-covered until you add classifying types.";

/**
 * Printed by `yg check` when it skipped the structural attention index because
 * the repository's .gitignore files do not ignore it. A check writes no tracked
 * file, so the line is added by `yg init --upgrade`, never by the check.
 */
export const FEATURE_INDEX_NOT_IGNORED_NOTICE =
  "The structural attention index (.yggdrasil/.feature-field.json) was not written: git does not ignore it here, and yg check never edits a tracked .gitignore. Run 'yg init --upgrade' to add the line.";
