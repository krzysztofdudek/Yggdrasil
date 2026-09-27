/**
 * Every issue code the CLI can put in front of a reader — the vocabulary, as
 * types. A code is a public name: it heads a text block (`error[<code>]`), it is
 * the `code` field of `yg-check/1`, `yg-error/1`, `yg-suppressions/1` and the
 * `yg marketplace check` report, and adopters and sibling tools branch on it.
 *
 * The union is what makes a code impossible to invent at an emit site: every
 * type that carries a code (a validation issue, a check issue, a diagnostic, a
 * parser refusal, a command error) is typed with one of these unions, so a
 * misspelled or unregistered literal fails the typecheck instead of shipping.
 * What each code MEANS — its severity rule, the stage that emits it, its
 * one-line meaning and its fix — is the registry in utils/issue-code-registry.ts,
 * which must hold exactly one entry per member here (it is typed
 * `{ [K in IssueCode]: … }`, so a code missing from it, or one it holds that is
 * not listed here, fails the typecheck too). The docs code tables are rendered
 * from that registry.
 *
 * Types only, as the model layer is: the registry lives in the utility layer,
 * which the model may not depend on.
 */

/**
 * The codes a `yg check` run reports as findings: graph loading and parsing,
 * graph validation, the lock and pair state, relations, coverage, the log gate
 * and the committed-artifact checks — every `code` of a `yg-check/1` issue, and
 * the codes `yg context` and `yg aspects` report from the same validation.
 */
export type CheckCode =
  // The graph did not load as written.
  | 'yaml-invalid'
  | 'config-invalid'
  | 'architecture-invalid'
  | 'lock-invalid'
  // Configuration file (yg-config.yaml, yg-secrets.yaml).
  | 'config-unknown-key'
  | 'config-committed-api-key'
  | 'reviewer-endpoint-committed'
  | 'secrets-file-tracked'
  | 'config-reviewer-missing'
  | 'config-reviewer-unknown-key'
  | 'config-tiers-missing'
  | 'config-tiers-empty'
  | 'config-tier-invalid'
  | 'config-tier-name-invalid'
  | 'config-tier-name-reserved'
  | 'config-tier-unknown-key'
  | 'config-tier-provider-missing'
  | 'config-tier-provider-unknown'
  | 'config-tier-config-missing'
  | 'config-tier-config-not-mapping'
  | 'config-tier-config-invalid'
  | 'config-tier-consensus-invalid'
  | 'config-tier-prompt-chars-invalid'
  | 'config-tier-endpoint-missing'
  | 'config-default-tier-missing'
  | 'config-default-tier-unknown'
  | 'config-coverage-unknown-key'
  | 'config-quality-unknown-key'
  | 'config-progressive-unknown-key'
  | 'config-events-unknown-key'
  | 'config-signals-unknown-key'
  | 'config-rules-artifacts-unknown-key'
  | 'config-rules-artifacts-orphan-import'
  // Architecture (yg-architecture.yaml) and node types.
  | 'architecture-cycle'
  | 'type-undefined'
  | 'type-undefined-pending'
  | 'type-unknown-parent'
  | 'parent-type-forbidden'
  | 'type-when-mismatch'
  | 'type-without-when-with-mapping'
  | 'enforce-strict-without-when'
  | 'relation-target-type-unknown'
  | 'when-predicate-invalid'
  | 'architecture-default-aspect-unreachable'
  // Components (yg-node.yaml), mapping and ports.
  | 'node-yaml-missing'
  | 'node-unreachable'
  | 'invalid-scope'
  | 'description-missing'
  | 'overlapping-mapping'
  | 'file-duplicate-mapping'
  | 'file-mapping-gitignored'
  | 'file-mapping-excluded'
  | 'mapping-escapes-repo'
  | 'mapping-path-missing'
  | 'mapping-path-case-mismatch'
  | 'file-unreadable'
  | 'port-undefined'
  | 'port-missing-aspect'
  // Relations and flows.
  | 'relation-broken'
  | 'relation-target-forbidden'
  | 'structural-cycle'
  | 'event-unpaired'
  | 'high-fan-out'
  | 'flow-node-broken'
  | 'relation-undeclared-dependency'
  | 'type-relation-forbidden'
  | 'relation-parse-failed'
  // Rules (yg-aspect.yaml and the rule directory).
  | 'aspect-invalid-id'
  | 'aspect-name-missing'
  | 'aspect-unknown-key'
  | 'aspect-field-invalid'
  | 'aspect-status-invalid'
  | 'aspect-review-by-malformed'
  | 'aspect-errs-invalid'
  | 'aspect-scope-invalid'
  | 'aspect-scope-on-aggregate'
  | 'aspect-when-invalid'
  | 'aspect-implies-not-array'
  | 'aspect-implies-invalid'
  | 'implies-status-inherit-invalid'
  | 'aspect-reviewer-missing'
  | 'aspect-reviewer-not-mapping'
  | 'aspect-reviewer-type-missing'
  | 'aspect-reviewer-type-invalid'
  | 'aspect-reviewer-unknown-key'
  | 'aspect-reviewer-tier-invalid'
  | 'aspect-tier-on-deterministic'
  | 'aspect-tier-on-aggregate'
  | 'aspect-tier-unknown'
  | 'aspect-references-on-deterministic'
  | 'aspect-references-on-aggregate'
  | 'aspect-references-empty-array'
  | 'aspect-reference-broken'
  | 'aspect-reference-invalid-form'
  | 'aspect-reference-blank-path'
  | 'aspect-reference-escape'
  | 'aspect-reference-duplicate'
  | 'aspect-reference-symlink'
  | 'aspect-source-symlink'
  | 'aspect-companion-missing'
  | 'aspect-companion-invalid'
  | 'aspect-companion-escape'
  | 'aspect-companion-without-content'
  | 'aspect-companion-with-check'
  | 'aspect-unexpected-rule-source'
  | 'aspect-missing-rule-source'
  | 'aspect-both-rule-sources'
  | 'aspect-empty'
  | 'aspect-undefined'
  | 'duplicate-aspect-id'
  | 'implied-aspect-missing'
  | 'aspect-implies-cycle'
  | 'aspect-status-downgrade'
  | 'aspect-status-changed-outside-cli'
  | 'aspect-effective-nowhere'
  | 'orphaned-aspect'
  | 'aspect-review-overdue'
  | 'when-unknown-type'
  | 'when-unknown-node'
  | 'when-unknown-port'
  | 'when-unmatched-port'
  // Installed packages and their adaptation files.
  | 'aspect-packages-dir-reserved'
  | 'package-file-modified'
  | 'package-manifest-invalid'
  | 'package-schema-unknown'
  | 'package-name-invalid'
  | 'package-version-invalid'
  | 'package-requires-missing'
  | 'package-requires-unsatisfied'
  | 'package-aspects-invalid'
  | 'package-aspect-dir-missing'
  | 'package-aspect-dir-undeclared'
  | 'package-config-schema-invalid'
  | 'package-config-schema-unknown-aspect'
  | 'package-config-key-type-missing'
  | 'package-config-default-type-mismatch'
  | 'package-implies-not-relative'
  | 'package-implies-outside-package'
  | 'aspect-adapt-invalid'
  | 'aspect-adapt-not-mapping'
  | 'aspect-adapt-key-not-adaptable'
  | 'aspect-adapt-key-unknown'
  | 'aspect-adapt-config-not-mapping'
  | 'aspect-adapt-config-key-unknown'
  | 'aspect-adapt-config-type-mismatch'
  // Verification: the lock and the (rule, unit) pairs.
  | 'unverified'
  | 'aspect-violation-enforced'
  | 'aspect-violation-advisory'
  | 'prompt-too-large'
  | 'aspect-companion-runtime-error'
  | 'suppress-marker-missing-reason'
  // Coverage.
  | 'unmapped-files'
  | 'uncovered-advisory'
  | 'tracked-file-gitignored'
  | 'ambiguous-node-type'
  | 'type-strict-orphan'
  | 'type-strict-misplaced'
  | 'strict-overlap-conflict'
  | 'coverage-required-shadowed'
  // Logs.
  | 'log-entry-missing'
  | 'log-entry-required'
  | 'log-cycle-open'
  | 'log-integrity'
  | 'log-format'
  | 'log-conflict'
  // Committed artifacts outside the graph.
  | 'rules-digest-stale'
  | 'incident-ledger-out-of-order';

/**
 * The codes a command error carries — the `code` of a `yg-error/1` document and
 * the word in its `error[<code>]:` heading. A command that fails over a graph
 * finding reports that finding's own code instead (a lock that does not parse is
 * `lock-invalid` on either surface), so a command error may carry a
 * {@link CheckCode} too.
 */
export type CommandErrorCode =
  | 'usage'
  | 'command-error'
  | 'internal'
  | 'node-not-found'
  | 'aspect-not-found'
  | 'graph-missing'
  | 'graph-load-failed'
  | 'lock-environment'
  | 'no-coverage'
  | 'adopt-restore-failed'
  | 'node-path-invalid'
  // yg log merge-resolve refusing a log it cannot reconcile.
  | 'log-merge-not-in-progress'
  | 'log-merge-log-missing'
  | 'log-merge-conflict-markers'
  | 'log-merge-sides-unreadable'
  | 'log-merge-history-rewritten'
  | 'log-merge-entries-lost'
  | 'log-merge-entries-unknown'
  | 'log-merge-out-of-order'
  // yg aspects log add refusing a status record.
  | 'aspect-status-value-invalid'
  | 'aspect-status-not-standing'
  | 'aspect-status-evidence-missing'
  | 'aspect-status-unchanged'
  | PackageCode;

/**
 * The refusals of the package commands (`yg pack add|update|remove|verify`) over
 * the package being installed or the repository's record of installed packages
 * (`.yggdrasil/yg-packages.yaml`).
 */
export type PackageCode =
  | 'package-install-failed'
  | 'package-manifest-missing'
  | 'package-symlink-refused'
  | 'package-binary-file-refused'
  | 'packages-lock-invalid'
  | 'packages-lock-schema-unknown'
  | 'packages-lock-package-invalid'
  | 'packages-lock-entry-invalid'
  | 'packages-lock-entry-incomplete'
  | 'packages-lock-hash-invalid'
  | 'packages-lock-path-escape';

/** The warnings `yg suppressions` lists for a `yg-suppress` marker (`yg-suppressions/1`). */
export type SuppressionCode = 'unknown-aspect' | 'wildcard' | 'unbounded-range' | 'waives-under' | 'missing-reason';

/** The findings of `yg marketplace check`, run in a package author's repository. */
export type MarketplaceCode =
  | 'marketplace-manifest-missing'
  | 'marketplace-manifest-invalid'
  | 'marketplace-schema-missing'
  | 'marketplace-schema-unknown'
  | 'marketplace-packages-invalid'
  | 'marketplace-entry-invalid'
  | 'marketplace-entry-duplicate'
  | 'marketplace-entry-escape'
  | 'marketplace-entry-version-invalid'
  | 'marketplace-entry-missing'
  | 'marketplace-dir-unlisted'
  | 'package-manifest-invalid'
  | 'package-name-mismatch'
  | 'package-version-mismatch'
  | 'package-requires-unsatisfied'
  | 'package-symlink-refused'
  | 'package-binary-file-refused'
  | 'package-aspect-invalid'
  | 'package-implies-escapes'
  | 'package-config-undeclared'
  | 'package-scope-literal-root'
  | 'package-review-by-present'
  | 'package-references-repo-path'
  | 'package-drills-missing'
  | 'package-file-unreadable'
  | 'package-config-unused'
  | 'package-config-dynamic'
  | 'package-reviewer-tier'
  | 'package-drills-unrecognized';

/** Every registered code. */
export type IssueCode = CheckCode | CommandErrorCode | SuppressionCode | MarketplaceCode;

/**
 * A check finding progressive mode put outside the measured change: its code
 * with `-outside` appended (utils/check-codes.ts spells the suffix once). Not a
 * registry entry of its own — it reads as the code it mirrors.
 */
export type OutsideTwinCode = `${CheckCode}-outside`;

/** A code a check issue can carry: a finding's own code, or its outside twin. */
export type CheckIssueCode = CheckCode | OutsideTwinCode;
