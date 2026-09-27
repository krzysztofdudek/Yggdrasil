/**
 * The issue-code registry: what every code the CLI can put in front of a reader
 * means. One entry per code — its severity rule, the stage that emits it, a
 * one-line meaning and a fix template — plus, for the few codes a report heads
 * or counts specially, the label, tier and noun it renders with.
 *
 * Why one table: codes used to be string literals scattered over the emitters,
 * with a partial set here, a partial table in the docs and another in the
 * knowledge topic, each covering a different subset — a code could be emitted
 * that no page explained, and a page could explain a code nothing emitted. Now:
 *
 *   - the vocabulary is the union in model/issue-code.ts, which every type that
 *     carries a code is typed with, so an emitter cannot invent a code;
 *   - this registry is typed `{ [K in IssueCode]: … }`, so it cannot miss a
 *     code of that union or hold one the union does not list;
 *   - the code tables of docs/cli-reference.md and of the knowledge
 *     cli-reference topic are rendered from it (a repository test fails when
 *     either drifts from what it renders, and rewrites both under
 *     `npm run codes:update`).
 *
 * Membership in the doctrine sets — structural, fill-gating, progressive
 * scoped — is NOT repeated here: those sets are declared once, with their
 * rationale, in utils/check-codes.ts (typed with the same union, so they cannot
 * name an unregistered code either), and the rendered tables read them beside
 * each entry. A second copy of a membership would be the drift this module
 * exists to end.
 *
 * Pure data and pure functions; a utility, so the engine, the parsers, the
 * formatters and the commands can all read it.
 */

import type { CheckCode, IssueCode } from '../model/issue-code.js';
import type { UnverifiedCause } from '../model/check-issue.js';
import { UNVERIFIED_CAUSE_ORDER } from './check-codes.js';
import { ASPECT_ADAPT_ROOT, ASPECT_SCOPE } from './file-formats-graph.js';
import { keysOf, refusedOf } from './file-schema.js';
import { providersWithDefaultModel } from './known-providers.js';

/**
 * Where a code sorts in a report, most urgent first.
 *   - T0: the graph itself did not load as written — every other finding in
 *     the run was computed on a fallback and may be a symptom of this one.
 *   - T1: code and graph errors — a refusal, a relation, coverage, structure.
 *   - T2: gate prerequisites — what must exist before verdicts can be recorded.
 *   - T3: pending — pairs a recording run fills.
 */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

/**
 * How a code weighs.
 *   - `error`: always an error — it fails the command, or `yg check`.
 *   - `warning`: always a warning — it is reported and never blocks.
 *   - `by-status`: follows the effective status of the rule it concerns — an
 *     error on an enforced rule, a warning on an advisory one.
 *   - `by-coverage-root`: an error under a `coverage.required` root, a warning
 *     outside every required root.
 * A code progressive mode may put outside a measured change (a member of
 * SCOPED_CODES in utils/check-codes.ts) additionally reads as a warning there,
 * whatever its rule here.
 */
export type SeverityRule = 'error' | 'warning' | 'by-status' | 'by-coverage-root';

/**
 * The stage a code is emitted at — which command, and which part of it, a
 * reader meets it in.
 */
export type CheckStage =
  /** A graph or configuration file could not be read or parsed as written. */
  | 'load'
  /** The graph validation `yg check` (and `yg context`) runs over the loaded graph. */
  | 'validate'
  /** The pairs and the lock: what `yg check` finds re-hashing the recorded verdicts. */
  | 'verify'
  /** The built-in relation-conformance check, run live on every `yg check`. */
  | 'relations'
  /** Coverage: which files a node or a type governs. */
  | 'coverage'
  /** The component log gate. */
  | 'log'
  /** Only a recording run (`yg check --approve`) reports it. */
  | 'fill';

export type OtherStage =
  /** A command refused (`yg-error/1`). */
  | 'command'
  /** `yg pack` — installing, updating or verifying a package. */
  | 'package'
  /** `yg suppressions` — the inventory of `yg-suppress` markers. */
  | 'suppressions'
  /** `yg marketplace check` — run in a package author's repository. */
  | 'marketplace';

export type IssueStage = CheckStage | OtherStage;

/** What the registry knows about one code. */
export interface IssueCodeEntry<S extends IssueStage = IssueStage> {
  severity: SeverityRule;
  stage: S;
  /** What the code means, in one line. */
  meaning: string;
  /** What to do about it — a template; `<node>`, `<rule>`, `<file>` stand for the finding's own. */
  fix: string;
  /** For a code whose finding says WHY in a `cause` field: the public cause names, in the order they are acted on. */
  causes?: readonly UnverifiedCause[];
  /** The heading word a report uses for this code, when it is not the code itself. */
  label?: string;
  /** The report tier this code sorts into, when it is not T1. */
  tier?: Tier;
  /** The singular noun a finding's members are counted in, when it is not `issue`. */
  noun?: string;
  /**
   * Set when the remedy is the user's decision, never the agent's: the step a
   * report's `next:` names for this code, worded as one to ask the user for.
   */
  decision?: string;
}

/**
 * The step that configures a reviewer, as a report names it: configuring one
 * sends code to that provider on the user's account, so it is always asked
 * for, never run. `--model` is required by every provider but claude-code, and
 * the draft alternative stays in view.
 */
export const CONFIGURE_REVIEWER_STEP = 'ask the user to approve configuring a reviewer — yg init --provider <name> [--model <m>] — or set the reviewer rules to status: draft';

/**
 * The step a report names for law on a type nobody admitted: ratifying is the
 * user's act, so the agent asks rather than writes it, and the other way out —
 * running the rule as advice — stays in view.
 */
const TYPE_LAW_STEP = 'ask the user whether they admit each rule named on the types it reaches — record an admission with yg log add --aspect --ratify, the command each finding names — or set the rule to status: advisory where it reaches the type';

type Registry = { readonly [K in CheckCode]: IssueCodeEntry<CheckStage> } & {
  readonly [K in Exclude<IssueCode, CheckCode>]: IssueCodeEntry<OtherStage>;
};

const ARCH = 'yg-architecture.yaml';
const CONFIG = 'yg-config.yaml';

// The lists a meaning or fix names are read from the schemas the parsers
// enforce, so the text cannot name a key or a provider the parser disagrees on.
const SCOPE_PER_TYPE = ASPECT_SCOPE.fields.per.type;
const SCOPE_PER_VALUES: readonly string[] = SCOPE_PER_TYPE.kind === 'string' && SCOPE_PER_TYPE.values !== undefined ? SCOPE_PER_TYPE.values : [];

/**
 * Every code, grouped by stage. Keys are the codes themselves; the order within
 * a group is the order the docs tables list them in.
 */
const ISSUE_CODE_REGISTRY: Registry = {
  // ── load: the graph did not load as written ─────────────────────────
  'yaml-invalid': { severity: 'error', stage: 'load', label: 'yaml-invalid', tier: 'T0', noun: 'file', meaning: 'A graph file (yg-node.yaml, yg-aspect.yaml, a flow\'s yg-flow.yaml) does not parse, is not a YAML mapping or breaks its schema — or a directory under flows/ has no yg-flow.yaml — so what it declares is not loaded; the rest of the graph is.', fix: 'Fix the file the finding names (yg schemas read gives each file\'s keys); the rest of the report may be a symptom of it.' },
  'config-invalid': { severity: 'error', stage: 'load', label: 'config-invalid', tier: 'T0', meaning: `${CONFIG} (or yg-secrets.yaml) does not parse or holds a value of the wrong shape; every setting falls back to its default until it does.`, fix: `Correct what the finding quotes in .yggdrasil/${CONFIG}; findings computed on the defaults clear with it.` },
  'architecture-invalid': { severity: 'error', stage: 'load', label: 'architecture-invalid', tier: 'T0', meaning: `${ARCH} does not parse, so no architecture rule (types, parents, allowed relations) is checked.`, fix: `Fix the YAML in .yggdrasil/${ARCH}.` },
  'lock-invalid': { severity: 'error', stage: 'load', label: 'lock-invalid', tier: 'T0', meaning: 'A committed lock file (yg-lock.nondeterministic.json, yg-lock.logs.json, yg-lock.types.json, or a legacy yg-lock.json) is unparseable, garbled, conflict-markered or of an unknown version — fail closed. The gitignored .yg-lock.deterministic.json is exempt: a fault there is discarded and the cache rebuilt.', fix: 'Restore the lock from version control (on a merge conflict take one side whole), then run yg check --approve; never hand-edit it.' },
  'when-predicate-invalid': { severity: 'error', stage: 'load', meaning: `A \`when:\` predicate in ${ARCH} does not parse, so the architecture is not loaded.`, fix: 'Fix the predicate; yg schemas read architecture gives the grammar.' },
  'config-unknown-key': { severity: 'error', stage: 'load', meaning: `A top-level key ${CONFIG} or yg-secrets.yaml does not know — whatever it was meant to set is not set. The rest of the configuration is in effect.`, fix: 'Rename the key to the one it is a typo of (the finding names it) or remove it.' },
  'config-reviewer-unknown-key': { severity: 'error', stage: 'load', meaning: 'reviewer: holds a key other than `default` and `tiers`.', fix: "Move provider settings into a tier's config: section, or remove the key." },
  'config-tiers-missing': { severity: 'error', stage: 'load', meaning: 'reviewer: has no tiers: mapping.', fix: 'Add reviewer.tiers with at least one tier, or remove the reviewer: section.' },
  'config-tiers-empty': { severity: 'error', stage: 'load', meaning: 'reviewer.tiers is an empty mapping.', fix: 'Add at least one tier.' },
  'config-tier-invalid': { severity: 'error', stage: 'load', meaning: 'A tier under reviewer.tiers is not a mapping.', fix: 'Write the tier as { provider, consensus, config: { model } }.' },
  'config-tier-name-invalid': { severity: 'error', stage: 'load', meaning: 'A tier name does not start with a letter or holds characters other than letters, digits, `_` and `-` (at most 63).', fix: 'Rename the tier, and every reviewer.tier: that names it.' },
  'config-tier-name-reserved': { severity: 'error', stage: 'load', meaning: 'A tier is named `default`, which reads as reviewer.default pointing at itself.', fix: 'Rename the tier, and every reviewer.tier: that names it.' },
  'config-tier-unknown-key': { severity: 'error', stage: 'load', meaning: "A tier, or a tier's config:, holds a key it does not accept — the setting it was meant to change stays at its default.", fix: 'Rename the key to the one it is a typo of (the finding names it) or remove it.' },
  'config-tier-provider-missing': { severity: 'error', stage: 'load', meaning: 'A tier declares no provider:.', fix: 'Add provider: with one of the known providers.' },
  'config-tier-provider-unknown': { severity: 'error', stage: 'load', meaning: 'A tier names a provider the CLI does not know how to call.', fix: 'Use one of the providers the finding lists.' },
  'config-tier-config-missing': { severity: 'error', stage: 'load', meaning: "A tier has no config: section, or its config: names no model: and its provider has no model of its own to fall back to.", fix: `Add config: { model: <name> } (only ${providersWithDefaultModel()} fall back to a model of their own).` },
  'config-tier-config-not-mapping': { severity: 'error', stage: 'load', meaning: "A tier's config: is not a mapping.", fix: 'Write config: as a mapping of provider settings.' },
  'config-tier-config-invalid': { severity: 'error', stage: 'load', meaning: "A value in a tier's config: has the wrong type (a model that is not a string, a timeout that is not a number).", fix: 'Set the value the finding names to the type it asks for.' },
  'config-tier-consensus-invalid': { severity: 'error', stage: 'load', meaning: "A tier's consensus is missing, not a positive integer, or even — an even vote cannot break a tie.", fix: 'Set consensus: 1, or an odd number of 3 or more for a majority vote.' },
  'config-tier-prompt-chars-invalid': { severity: 'error', stage: 'load', meaning: "A tier's max_prompt_chars is zero, negative or fractional.", fix: 'Set max_prompt_chars to a positive integer, or remove it for the default.' },
  'config-tier-endpoint-missing': { severity: 'error', stage: 'load', meaning: 'An openai-compatible tier has no config.endpoint, so it would fall back to the public OpenAI API.', fix: 'Add config.endpoint pointing at the compatible server.' },
  'config-default-tier-missing': { severity: 'error', stage: 'load', meaning: 'Several tiers are configured and reviewer.default does not say which one a rule without reviewer.tier uses.', fix: 'Set reviewer.default to one of the configured tier names.' },
  'config-default-tier-unknown': { severity: 'error', stage: 'load', meaning: 'reviewer.default is not a string, or names a tier that is not configured.', fix: 'Set reviewer.default to one of the configured tier names.' },
  'config-coverage-unknown-key': { severity: 'error', stage: 'load', meaning: 'coverage: holds a key other than `required`, `excluded` and `type_level`.', fix: 'Rename the key to the one it is a typo of, or remove it.' },
  'config-quality-unknown-key': { severity: 'error', stage: 'load', meaning: 'quality: holds a key it does not know — the threshold it was meant to set stays at its default.', fix: 'Rename the key to the one it is a typo of (the finding names it), or remove it.' },
  'config-progressive-unknown-key': { severity: 'error', stage: 'load', meaning: 'progressive: holds a key other than `reference`, or is not a mapping.', fix: 'Write progressive: { reference: <branch> }, or remove the key.' },
  'config-events-unknown-key': { severity: 'error', stage: 'load', meaning: 'events: holds a key other than `committed_llm`, or is not a mapping.', fix: 'Write events: { committed_llm: true|false }, or remove the key.' },
  'config-signals-unknown-key': { severity: 'error', stage: 'load', meaning: 'signals: holds a key other than `attention`, or is not a mapping.', fix: 'Write signals: { attention: true|false }, or remove the key.' },
  'config-rules-artifacts-unknown-key': { severity: 'error', stage: 'load', meaning: 'rules_artifacts: holds a key other than `agents_md`, `claude_md` and `clinerules`, a non-boolean value, or is not a mapping.', fix: 'Set each of the three to true or false, or remove the key (absent means true).' },
  'config-rules-artifacts-orphan-import': { severity: 'error', stage: 'load', meaning: 'rules_artifacts turns claude_md on while agents_md is off — CLAUDE.md would import an AGENTS.md block nobody writes.', fix: 'Turn agents_md on, or claude_md off.' },
  'aspect-invalid-id': { severity: 'error', stage: 'load', meaning: 'A rule directory yields an empty rule id.', fix: 'Rename the directory under aspects/ to the intended rule id.' },
  'aspect-name-missing': { severity: 'error', stage: 'load', meaning: 'A yg-aspect.yaml has no name:.', fix: 'Add name: to the file.' },
  'aspect-unknown-key': { severity: 'error', stage: 'load', meaning: 'A yg-aspect.yaml holds a key it does not accept (a typo such as `stauts:`); the rule is not loaded until it is corrected.', fix: 'Rename the key to the one it is a typo of (the finding names it), or remove it.' },
  'aspect-field-invalid': { severity: 'error', stage: 'load', meaning: 'A yg-aspect.yaml (with its adaptation, for an installed rule) holds a value of the wrong type for a key it accepts — a description that is a list, a reference description that is a number; the rule is not loaded until it is corrected.', fix: 'Set the value the finding names to the type it asks for; yg schemas read aspect gives each key\'s type.' },
  'aspect-status-invalid': { severity: 'error', stage: 'load', meaning: 'A declared status: is not one of draft, advisory, enforced.', fix: 'Set status: to draft, advisory or enforced.' },
  'aspect-review-by-malformed': { severity: 'error', stage: 'load', meaning: 'A rule\'s review_by: is present but not a calendar-valid bare YYYY-MM-DD date (2027-13-01, 2027-02-30). Fired only on the rule that carries the field.', fix: 'Write review_by: as a real YYYY-MM-DD date — with the user\'s approval, since the date is theirs.' },
  'aspect-errs-invalid': { severity: 'error', stage: 'load', meaning: 'errs: is not one of over, under, exact, or is declared on a rule that is not a script rule.', fix: 'Set errs to over, under or exact on a script rule, or remove it.' },
  'aspect-scope-invalid': { severity: 'error', stage: 'load', meaning: 'scope: is not a mapping, or its per:/files: do not have the accepted form.', fix: `Write scope: { per: ${SCOPE_PER_VALUES.join('|')}, files: <file predicate> } — a file predicate is path:/content: atoms, combined with all_of/any_of/not; yg schemas read aspect gives the shape.` },
  'aspect-scope-on-aggregate': { severity: 'error', stage: 'load', meaning: 'A bundle (no content.md, no check.mjs) declares scope:, which only a rule with a rule source can use.', fix: 'Remove scope:, or add content.md or check.mjs to make the bundle a rule.' },
  'aspect-when-invalid': { severity: 'error', stage: 'load', meaning: "A rule's own when:, or the when: of one of its implies entries, does not parse.", fix: 'Correct the predicate; yg knowledge read conditional-aspects gives the grammar.' },
  'aspect-implies-not-array': { severity: 'error', stage: 'load', meaning: 'implies: is not a list.', fix: 'Write implies: as a list of rule ids (or { id, when, status_inherit } entries).' },
  'aspect-implies-invalid': { severity: 'error', stage: 'load', meaning: 'An implies: entry is neither a rule id nor an { id, when?, status_inherit? } mapping.', fix: 'Fix the entry; yg schemas read aspect gives the shape.' },
  'implies-status-inherit-invalid': { severity: 'error', stage: 'load', meaning: 'An implies entry\'s status_inherit: is not `strictest` or `own-default`.', fix: 'Set status_inherit: to strictest or own-default.' },
  'aspect-reviewer-missing': { severity: 'error', stage: 'load', meaning: 'A rule has no rule source (content.md or check.mjs) and implies nothing, so there is nothing to infer its kind from and it would do nothing.', fix: 'Add content.md (a reviewer rule) or check.mjs (a script rule), or declare implies: to make it a bundle.' },
  'aspect-reviewer-not-mapping': { severity: 'error', stage: 'load', meaning: 'reviewer: is present but not a mapping.', fix: 'Write reviewer: as a mapping with type: and optionally tier:, or remove it (the kind is inferred from the rule source).' },
  'aspect-reviewer-type-missing': { severity: 'error', stage: 'load', meaning: 'reviewer: is a mapping without type:.', fix: 'Add type: llm, deterministic or aggregate, or remove reviewer: to have the kind inferred.' },
  'aspect-reviewer-type-invalid': { severity: 'error', stage: 'load', meaning: 'reviewer.type is not llm, deterministic or aggregate.', fix: 'Set reviewer.type to llm, deterministic or aggregate.' },
  'aspect-reviewer-unknown-key': { severity: 'error', stage: 'load', meaning: 'reviewer: holds a key other than `type` and `tier`.', fix: 'Remove the key.' },
  'aspect-reviewer-tier-invalid': { severity: 'error', stage: 'load', meaning: 'reviewer.tier is empty or not a string.', fix: 'Set tier: to a configured tier name, or remove it for the default tier.' },
  'aspect-tier-on-deterministic': { severity: 'error', stage: 'load', meaning: 'A script rule sets reviewer.tier: — tiers choose a reviewer model and a script rule has none.', fix: 'Remove reviewer.tier from the rule.' },
  'aspect-tier-on-aggregate': { severity: 'error', stage: 'load', meaning: 'A bundle sets reviewer.tier: — a bundle has no verdict of its own and no reviewer.', fix: 'Remove reviewer.tier from the bundle.' },
  'aspect-references-on-deterministic': { severity: 'error', stage: 'load', meaning: 'A script rule declares references:, which only a reviewer is shown.', fix: 'Remove references:, or read the files from check.mjs through its context.' },
  'aspect-references-on-aggregate': { severity: 'error', stage: 'load', meaning: 'A bundle declares references:, which it has no reviewer to show.', fix: 'Remove references: from the bundle.' },
  'aspect-reference-invalid-form': { severity: 'error', stage: 'load', meaning: 'references: is not a list, or an entry is neither a path nor a { path, description } mapping.', fix: 'Write each entry as a repo-relative path or { path, description }.' },
  'aspect-reference-blank-path': { severity: 'error', stage: 'load', meaning: 'A references: entry has an empty path.', fix: 'Give the entry a real file path, or remove it.' },
  'aspect-reference-escape': { severity: 'error', stage: 'load', meaning: 'A references: entry is absolute or climbs above the repository root.', fix: 'Use a path relative to the repository root.' },
  'aspect-reference-duplicate': { severity: 'error', stage: 'load', meaning: 'A references: entry is listed more than once.', fix: 'Remove the duplicate entry.' },
  'aspect-source-symlink': { severity: 'error', stage: 'load', meaning: 'A rule source (content.md, check.mjs, companion.mjs) runs through a symbolic link — refused, never followed: a link can reach outside the repository and resolve differently on each machine.', fix: 'Replace the link with the file itself.' },
  'aspect-companion-invalid': { severity: 'error', stage: 'load', meaning: 'companion: is not a path string.', fix: 'Set companion: to a repo-relative module path, or remove it.' },
  'aspect-companion-escape': { severity: 'error', stage: 'load', meaning: 'companion: leaves the repository root.', fix: 'Move the module into the repository and give companion: a repo-relative path.' },
  'aspect-companion-missing': { severity: 'error', stage: 'load', meaning: 'companion: names a file that is not there or cannot be read.', fix: 'Fix the path, or add the module.' },
  'aspect-packages-dir-reserved': { severity: 'error', stage: 'load', meaning: 'A rule of the repository\'s own sits under aspects/packages/, which is reserved for installed packages; it is not loaded.', fix: 'Move the rule out of aspects/packages/ (and update the ids that name it).' },
  'package-manifest-invalid': { severity: 'error', stage: 'load', meaning: 'An installed package\'s yg-package.yaml — or, under yg marketplace check, a published one — is not valid YAML or not a mapping, or its identity disagrees with where it is published.', fix: 'Reinstall the package (yg pack update), or, as its author, fix the manifest.' },
  'package-schema-unknown': { severity: 'error', stage: 'load', meaning: "An installed package's yg-package.yaml declares a schema this build does not know.", fix: 'Upgrade the CLI, or install a release of the package built for this one.' },
  'package-name-invalid': { severity: 'error', stage: 'load', meaning: "An installed package's name is not a single path segment.", fix: 'Reinstall the package from its marketplace; as its author, fix name:.' },
  'package-version-invalid': { severity: 'error', stage: 'load', meaning: "An installed package's version is not semver.", fix: 'Reinstall the package from its marketplace; as its author, fix version:.' },
  'package-requires-missing': { severity: 'error', stage: 'load', meaning: 'An installed package does not declare requires.yg, so nothing says which CLI can run it.', fix: 'Install a release of the package that declares requires.yg.' },
  'package-requires-unsatisfied': { severity: 'error', stage: 'load', meaning: 'A package needs a Yggdrasil version range this CLI is outside of.', fix: 'Upgrade Yggdrasil to a version in the range, or install a release of the package built for this one.' },
  'package-aspects-invalid': { severity: 'error', stage: 'load', meaning: "An installed package's aspects: is absent, not a list, or lists a directory twice.", fix: 'Reinstall the package from its marketplace; as its author, fix aspects:.' },
  'package-aspect-dir-missing': { severity: 'error', stage: 'load', meaning: 'An installed package declares a rule directory it does not carry.', fix: 'Reinstall the package (yg pack update).' },
  'package-aspect-dir-undeclared': { severity: 'error', stage: 'load', meaning: 'An installed package carries a rule directory its aspects: does not declare — a rule that would ride in unannounced.', fix: 'Reinstall the package (yg pack update); as its author, declare or remove the directory.' },
  'package-config-schema-invalid': { severity: 'error', stage: 'load', meaning: "An installed package's config: schema is not a mapping of rule to { key: { type, default } }.", fix: 'Reinstall the package; as its author, fix config:.' },
  'package-config-schema-unknown-aspect': { severity: 'error', stage: 'load', meaning: "An installed package's config: declares settings for a rule it does not carry.", fix: 'Reinstall the package; as its author, fix config:.' },
  'package-config-key-type-missing': { severity: 'error', stage: 'load', meaning: 'A setting in an installed package\'s config: has no type, or one other than string, number, boolean.', fix: 'Reinstall the package; as its author, give the setting a type.' },
  'package-config-default-type-mismatch': { severity: 'error', stage: 'load', meaning: "A setting's default in an installed package's config: is not of its declared type.", fix: 'Reinstall the package; as its author, fix the default.' },
  'package-implies-not-relative': { severity: 'error', stage: 'load', meaning: 'A rule of a package implies another by a full path instead of the rule\'s directory name inside the package.', fix: 'As the package author, name the implied rule by its directory name alone.' },
  'package-implies-outside-package': { severity: 'error', stage: 'load', meaning: 'A rule of a package implies a rule that package does not carry.', fix: 'As the package author, imply only the package\'s own rules.' },
  'aspect-adapt-invalid': { severity: 'error', stage: 'load', meaning: "An installed rule's adaptation file (yg-aspect.adapt.yaml) is not valid YAML.", fix: 'Fix the YAML syntax in the adaptation file.' },
  'aspect-adapt-not-mapping': { severity: 'error', stage: 'load', meaning: 'An adaptation file is not a mapping.', fix: 'Write the adaptation as a YAML mapping, e.g. status: advisory.' },
  'aspect-adapt-key-not-adaptable': { severity: 'error', stage: 'load', meaning: `An adaptation sets a key a package rule does not let a consumer change (${Object.keys(refusedOf(ASPECT_ADAPT_ROOT)).join(', ')}).`, fix: `Remove the key; the adaptable keys are ${keysOf(ASPECT_ADAPT_ROOT).join(', ')}.` },
  'aspect-adapt-key-unknown': { severity: 'error', stage: 'load', meaning: 'An adaptation sets a key that is no key of an adaptation.', fix: 'Remove or rename the key; the finding lists the adaptable keys.' },
  'aspect-adapt-config-not-mapping': { severity: 'error', stage: 'load', meaning: "An adaptation's config: is not a mapping.", fix: 'Write config: as a mapping of setting to value.' },
  'aspect-adapt-config-key-unknown': { severity: 'error', stage: 'load', meaning: 'An adaptation sets a config key the package does not declare for the rule.', fix: 'Remove the key; the package\'s yg-package.yaml lists the settings it reads.' },
  'aspect-adapt-config-type-mismatch': { severity: 'error', stage: 'load', meaning: 'An adaptation sets a config key to a value of another type than the package declares.', fix: 'Give the setting a value of the declared type.' },

  // ── validate: the graph validation ──────────────────────────────────
  'config-committed-api-key': { severity: 'warning', stage: 'validate', meaning: `The committed ${CONFIG} holds a reviewer api_key — a credential every clone and fork receives. The reviewer still uses it.`, fix: 'Nothing, if sharing the key is intended; otherwise move it to the gitignored .yggdrasil/yg-secrets.yaml (or the provider\'s environment variable) and replace it if it was committed.' },
  'secrets-file-tracked': { severity: 'warning', stage: 'validate', meaning: '.yggdrasil/yg-secrets.yaml, the local credentials overlay, is tracked by git. Its keys still work.', fix: 'Nothing, if sharing it is intended; otherwise git rm --cached .yggdrasil/yg-secrets.yaml, keep it gitignored, and replace any key it held.' },
  'reviewer-endpoint-committed': { severity: 'warning', stage: 'validate', meaning: "A tier sends the developer's key to an endpoint named in the committed yg-config.yaml only — for anthropic, openai or google any endpoint but the provider's own; for openai-compatible, when its key is a config.api_key. The key is sent; the warning shows where.", fix: 'Nothing, if the endpoint is yours (naming it for the tier in yg-secrets.yaml silences the warning); otherwise remove it from yg-config.yaml.' },
  'config-reviewer-missing': { severity: 'by-status', stage: 'validate', label: 'config-reviewer-missing', tier: 'T2', decision: CONFIGURE_REVIEWER_STEP, meaning: `An effective reviewer rule and no reviewer: section in ${CONFIG}. Follows the strictest status among the reviewer pairs left without a reviewer. Stops a full yg check --approve; never stops --only-deterministic or --dry-run.`, fix: 'yg init --provider <name> [--model <m>] (the user\'s decision), or set the reviewer rules to status: draft.' },
  'architecture-cycle': { severity: 'error', stage: 'validate', meaning: 'The parents: declarations of some node types form a cycle with no rootable type (one with no parents:, or with root among them), so nodes of those types can never be placed.', fix: 'Add root to one of the types\' parents: so it may sit at the top level, add a rootable parent, or remove one parents: entry.' },
  'type-undefined': { severity: 'error', stage: 'validate', meaning: `A node's type: is not defined in ${ARCH}.`, fix: `Define the type in ${ARCH} (the user's decision) or change the node's type.` },
  'type-undefined-pending': { severity: 'warning', stage: 'validate', meaning: `A node names a type while ${ARCH} declares no node types yet; types are not checked until the first one is.`, fix: `Define the type under node_types in ${ARCH} (the user's decision).` },
  'type-name-reserved': { severity: 'error', stage: 'validate', meaning: 'A node type is named root, the reserved parents: entry for the top level of the model.', fix: `Rename the type in ${ARCH} and in every node that declares it (the user's decision).` },
  'type-unknown-parent': { severity: 'error', stage: 'validate', meaning: 'A type\'s parents: names a type that is not defined (root, the top level, is the one entry that names no type).', fix: 'Define the parent type, or remove it from parents:.' },
  'parent-type-forbidden': { severity: 'error', stage: 'validate', meaning: "A node sits under a parent whose type is not one of its own type's allowed parents, or at the top level while its type's parents: do not name root.", fix: `Move the node, change a type, or allow the parent (root for the top level) in ${ARCH} (the user's decision).` },
  'type-when-mismatch': { severity: 'error', stage: 'validate', meaning: "A file in a node's mapping does not satisfy its type's when: predicate.", fix: "Move the file to a node of a fitting type (yg type-suggest --file <file>), refactor it, or broaden the type's when: (the user's decision)." },
  'type-without-when-with-mapping': { severity: 'error', stage: 'validate', meaning: 'A node of an organizational type (one with no when:) maps files.', fix: "Add a when: to the type, move the files to a node of a type that has one, or empty the node's mapping." },
  'enforce-strict-without-when': { severity: 'error', stage: 'validate', meaning: 'A type sets enforce: strict without a when: predicate, so there is nothing to enforce.', fix: 'Add a when: to the type, or remove enforce: strict.' },
  'relation-target-type-unknown': { severity: 'error', stage: 'validate', meaning: "A type's relations: allow-list names a target type that is not defined (and is not `*`), which silently over-restricts the relation.", fix: "Fix the spelling, define the type, use '*', or remove the entry." },
  'architecture-default-aspect-unreachable': { severity: 'warning', stage: 'validate', meaning: "A type's own default rule is effective on none of that type's instances — its when: filters it off the type that declares it.", fix: "Widen or remove the when:, or drop the default; for a per: node default whose type has only type-covered files, give a file a node of its own or make the rule per: file." },
  'node-yaml-missing': { severity: 'error', stage: 'validate', meaning: 'A directory under model/ holds files but no yg-node.yaml.', fix: 'Create yg-node.yaml there, or move the files to a node directory.' },
  'node-unreachable': { severity: 'error', stage: 'validate', meaning: 'A yg-node.yaml the loader never reached — under a directory that is no node, or beneath a node that failed to load — so nothing it declares is enforced.', fix: 'Give every directory above it a yg-node.yaml, or fix the node above it that failed to load.' },
  'invalid-scope': { severity: 'error', stage: 'validate', meaning: 'A validation was asked for a node the graph does not contain.', fix: 'yg find "<node>" to locate the node you meant.' },
  'description-missing': { severity: 'error', stage: 'validate', meaning: 'A node, rule or flow has no description, which context output depends on.', fix: 'Add a description: to its yaml.' },
  'overlapping-mapping': { severity: 'error', stage: 'validate', meaning: "Two nodes' mapping entries overlap, so a file would have two owners.", fix: 'Keep one owner mapping and model the other concern with a relation.' },
  'file-duplicate-mapping': { severity: 'error', stage: 'validate', meaning: 'One file appears in the mappings of more than one node.', fix: 'Remove the file from all but the node that owns it.' },
  'file-mapping-gitignored': { severity: 'error', stage: 'validate', meaning: 'A literal mapping entry names a gitignored file, which the disk walk never sees.', fix: 'Un-ignore the file, or remove it from the mapping.' },
  'file-mapping-excluded': { severity: 'error', stage: 'validate', meaning: 'A mapping entry names a file coverage.excluded cuts out, so it is never enforced however deliberately it is mapped.', fix: 'Remove the file from the mapping, or narrow the exclusion.' },
  'mapping-escapes-repo': { severity: 'error', stage: 'validate', meaning: 'A mapping entry is absolute or climbs above the repository root.', fix: 'Make the entry repo-relative, with no .. above the root.' },
  'mapping-path-missing': { severity: 'error', stage: 'validate', meaning: 'A mapping entry — a path or a glob — matches nothing on disk.', fix: 'Fix the entry, or remove it.' },
  'mapping-path-case-mismatch': { severity: 'error', stage: 'validate', meaning: 'A mapping entry matches a file only case-insensitively; on a case-sensitive file system (CI) it matches nothing.', fix: 'Spell the entry exactly as the file is named.' },
  'file-unreadable': { severity: 'error', stage: 'validate', meaning: 'A file a check had to read — a mapped source, a file a type\'s content: predicate scans, a log — could not be read, or exceeds the content-scan limit.', fix: 'Make the file readable, or take it out of what the check reads (gitignore, coverage.excluded, or drop the content: atom).' },
  'port-undefined': { severity: 'error', stage: 'validate', meaning: 'A relation names a port the target node does not declare.', fix: 'Name one of the ports the finding lists, or declare the port on the target.' },
  'port-missing-aspect': { severity: 'error', stage: 'validate', meaning: 'A port requires a rule that is not defined.', fix: 'Create the rule under aspects/, or remove it from the port.' },
  'relation-broken': { severity: 'error', stage: 'validate', meaning: 'A relation targets a node the graph does not contain.', fix: 'Correct the target in the node\'s relations:, or remove the relation.' },
  'relation-target-forbidden': { severity: 'error', stage: 'validate', meaning: 'A relation\'s type is not allowed between the two nodes\' types by the architecture.', fix: `Change the relation type or a node type, or allow it in ${ARCH} (the user's decision).` },
  'structural-cycle': { severity: 'error', stage: 'validate', meaning: 'The declared structural relations (calls / uses / extends / implements) form a cycle — including a node relating to itself. Not an aspect: no status, not suppressible. Reported once per group of nodes that reach each other.', fix: 'Break the cycle: extract the shared piece into a third node both depend on, or invert one dependency.' },
  'event-unpaired': { severity: 'error', stage: 'validate', meaning: 'An emits relation has no matching listens on the other side (or the reverse).', fix: 'Add the matching listens (or emits) relation, or remove the unpaired one.' },
  'high-fan-out': { severity: 'warning', stage: 'validate', meaning: 'A node has more direct relations than quality.max_direct_relations.', fix: 'Split the node, or route its relations through an intermediary node.' },
  'flow-node-broken': { severity: 'error', stage: 'validate', meaning: 'A flow names a node that does not exist, or whose yg-node.yaml did not load.', fix: 'Fix the node name in the flow, or the node\'s yaml.' },
  'aspect-unexpected-rule-source': { severity: 'error', stage: 'validate', meaning: 'A bundle (implies only, no reviewer.type) ships a rule source that is never read.', fix: 'Remove the rule source to keep the bundle, or declare reviewer.type to make it a rule.' },
  'aspect-missing-rule-source': { severity: 'error', stage: 'validate', meaning: 'A rule\'s declared reviewer.type has no matching rule source (llm without content.md, deterministic without check.mjs).', fix: 'Add the rule source its type needs, or change reviewer.type.' },
  'aspect-both-rule-sources': { severity: 'error', stage: 'validate', meaning: 'A rule ships both content.md and check.mjs.', fix: 'Remove the rule source that does not match its kind.' },
  'aspect-empty': { severity: 'error', stage: 'validate', meaning: 'A rule has no content.md, no check.mjs and no implies — it does nothing.', fix: 'Add a rule source or implies:, or remove the rule.' },
  'aspect-companion-without-content': { severity: 'error', stage: 'validate', meaning: 'A rule has a companion (companion.mjs, or the companion: key in yg-aspect.yaml) without content.md; a companion is an add-on to a reviewer rule.', fix: 'Add content.md, or remove companion.mjs.' },
  'aspect-companion-with-check': { severity: 'error', stage: 'validate', meaning: 'A rule has a companion (companion.mjs, or the companion: key in yg-aspect.yaml) beside check.mjs; companions apply to reviewer rules only.', fix: 'Remove the companion, or make the rule a reviewer rule.' },
  'aspect-references-empty-array': { severity: 'warning', stage: 'validate', meaning: 'A rule declares references: [] — an empty list that does nothing.', fix: 'Fill the list, or remove the references: line.' },
  'aspect-reference-broken': { severity: 'error', stage: 'validate', meaning: 'A references: entry names a file that does not exist.', fix: 'Create the file, fix the path, or remove the entry.' },
  'aspect-reference-symlink': { severity: 'error', stage: 'validate', meaning: 'A references: entry runs through a symbolic link; no fill runs until it is replaced by the file itself.', fix: 'Reference the file itself instead of the link, or remove the entry.' },
  'aspect-tier-unknown': { severity: 'error', stage: 'validate', meaning: 'A rule names a reviewer tier that is not configured.', fix: 'Name a configured tier, or remove reviewer.tier for the default.' },
  'aspect-undefined': { severity: 'error', stage: 'validate', meaning: 'A node, type, flow or port attaches a rule id that no directory under aspects/ defines.', fix: 'Create the rule, or fix or remove the attach.' },
  'duplicate-aspect-id': { severity: 'error', stage: 'validate', meaning: 'Two rules resolve to one id.', fix: 'Rename one of the rule directories.' },
  'implied-aspect-missing': { severity: 'error', stage: 'validate', meaning: 'A rule implies a rule id that does not exist.', fix: 'Create the implied rule, or remove it from implies:.' },
  'aspect-implies-cycle': { severity: 'error', stage: 'validate', meaning: 'The implies: edges form a cycle, so effective rules cannot be resolved.', fix: 'Remove one implies edge of the cycle.' },
  'aspect-status-downgrade': { severity: 'error', stage: 'validate', meaning: 'An attach site declares a status lower than the cascade yields (raising is allowed, lowering is not).', fix: 'Remove the lower status:, or lower the rule\'s own status (the user\'s decision).' },
  'aspect-status-changed-outside-cli': { severity: 'warning', stage: 'validate', meaning: "A rule's status changed since this machine's cache last saw it, and its own log does not record the change (its newest status entry names another status); a full fill writes the bare fact into that log if nobody does. A fresh checkout (CI) has no earlier status to compare, so it never reports this.", fix: "yg log add --aspect <rule> --status <status> --evidence '<what justified it>' --reason '<why>'." },
  'aspect-effective-nowhere': { severity: 'warning', stage: 'validate', meaning: 'A rule that ships a rule source and is not draft is effective on zero nodes after the full cascade and every when: — it looks enforced and verifies nothing.', fix: 'Fix the attach sites or when:, or set status: draft until what it targets exists; for a per: node rule whose type has only type-covered files, give a file a node or make the rule per: file.' },
  'orphaned-aspect': { severity: 'warning', stage: 'validate', meaning: 'A bundle, a draft rule, or a rule in a graph with no code yet is attached nowhere.', fix: 'Attach it to a node, type or flow, or remove it.' },
  'aspect-review-overdue': { severity: 'warning', stage: 'validate', meaning: "A rule's review_by: date has passed — it is running unreviewed. Never blocks and never writes a verdict.", fix: 'Ask the user to renew or retire the rule; never change the date yourself.' },
  'when-unknown-type': { severity: 'error', stage: 'validate', meaning: 'A when: predicate names a node type that is not defined.', fix: 'Fix the type name, or define the type.' },
  'when-unknown-node': { severity: 'error', stage: 'validate', meaning: 'A when: predicate names a node that does not exist.', fix: 'Fix the node path, or create the node.' },
  'when-unknown-port': { severity: 'error', stage: 'validate', meaning: 'A when: predicate\'s consumes_port names a port the target node does not declare.', fix: 'Fix the port name, or declare the port on the target.' },
  'when-unmatched-port': { severity: 'warning', stage: 'validate', meaning: 'A has_port predicate names a port no node declares, so it is false everywhere.', fix: 'Fix the port name if it is a typo; leave it if the never-match is deliberate.' },
  'package-file-modified': { severity: 'error', stage: 'validate', meaning: 'A file installed from a package no longer matches what the package published — edited, missing, or never installed — or the record of installed packages cannot be read. Built in: not suppressible.', fix: 'yg pack update <package> to restore it, or adapt the rule through its yg-aspect.adapt.yaml instead of editing the copy.' },
  'rules-digest-stale': { severity: 'warning', stage: 'validate', meaning: 'The committed agent-rules digest (the AGENTS.md block, .clinerules/yggdrasil.md, or the CLAUDE.md @AGENTS.md import) is missing, hand-edited, from an older CLI, or duplicated. Only artifacts rules_artifacts keeps on are compared.', fix: 'yg init --upgrade' },
  'incident-ledger-out-of-order': { severity: 'warning', stage: 'validate', meaning: 'The incident ledger\'s entry datetimes are not strictly ascending — the mark of a hand-edit or a reordering merge.', fix: 'Reorder the entries so datetimes ascend; never fabricate a datetime.' },

  // ── verify: the pairs and the lock ──────────────────────────────────
  'unverified': { severity: 'by-status', stage: 'verify', label: 'unverified', tier: 'T3', noun: 'pair', causes: UNVERIFIED_CAUSE_ORDER, meaning: 'An expected pair has no valid verdict. Grouped, and in --json tagged `cause`, by why: stale, keyed by an earlier release, never reviewed, a script check not run on this checkout, no reviewer configured, or — on the report of the fill that hit it — a reviewer unreachable, a reviewer that returned no verdict, a check.mjs that failed to run, or a yg-suppress marker with no reason.', fix: 'The group names the fix for its cause: yg check --approve for a pair waiting for a fill (--only-deterministic for a script pair, free), the configuration or the check for an infrastructure cause.' },
  'aspect-violation-enforced': { severity: 'error', stage: 'verify', label: 'refused', noun: 'pair', meaning: 'A valid refused verdict on an enforced pair — cached and final for unchanged inputs.', fix: 'Fix the code, sharpen the rule (re-verifies every node using it), or a yg-suppress with the user\'s approval.' },
  'aspect-violation-advisory': { severity: 'warning', stage: 'verify', label: 'refused', noun: 'pair', meaning: 'A valid refused verdict on an advisory pair — reported, never blocks.', fix: 'Fix the code, or sharpen the rule.' },
  'prompt-too-large': { severity: 'error', stage: 'verify', label: 'prompt-too-large', noun: 'pair', meaning: "The assembled reviewer prompt exceeds the resolved tier's max_prompt_chars — an error at any status. Takes precedence over unverified; --approve skips the pair.", fix: 'Split the node or the rule, narrow the rule\'s scope, or raise max_prompt_chars for the tier.' },
  'suppress-marker-missing-reason': { severity: 'warning', stage: 'verify', meaning: 'A yg-suppress marker in a mapped source has no reason. It waives nothing, and fails only what it would have waived: the first violation of a rule it names in its range makes the fill reject it and leave that pair unverified, and a reviewer pair of a rule it names stays unverified. Other rules are unaffected.', fix: 'Add the reason (the user approves it), or remove the marker.' },

  // ── relations: the built-in relation-conformance check ──────────────
  'relation-undeclared-dependency': { severity: 'error', stage: 'relations', meaning: "A node depends on another node's code without a declared relation. Built in, not an aspect: no status, not suppressible, never cached.", fix: 'Declare a structural relation (uses, calls, extends or implements) in the node\'s yg-node.yaml, or remove the dependency.' },
  'type-relation-forbidden': { severity: 'error', stage: 'relations', meaning: 'With coverage.type_level on, a statically resolved import between two classified endpoints (a node and/or a type-covered file) has no structural relation type (uses, calls, extends, implements) the architecture allows between their types; an event type alone sanctions no import.', fix: `Allow the type pair in ${ARCH} (the user's decision), give the target an explicit node with a relation, or remove the dependency.` },
  'relation-parse-failed': { severity: 'error', stage: 'relations', meaning: 'A language parser the relation check needs could not be loaded, so the dependencies of the files it covers cannot be checked.', fix: 'Reinstall the CLI to restore its bundled language support, then run yg check.' },

  // ── coverage ────────────────────────────────────────────────────────
  'unmapped-files': { severity: 'error', stage: 'coverage', label: 'unmapped', noun: 'file', meaning: 'Source files under a coverage.required root that no node maps and no type covers.', fix: 'Map the files to a node (yg context --file <file> lists candidates), or move their root out of coverage.required.' },
  'uncovered-advisory': { severity: 'warning', stage: 'coverage', label: 'uncovered', noun: 'file', meaning: 'Source files outside every coverage.required root that nothing covers — shown, never blocking.', fix: 'Map them to a node, or add their root to coverage.required to make this an error.' },
  'tracked-file-gitignored': { severity: 'by-coverage-root', stage: 'coverage', meaning: 'A file committed to git is matched by .gitignore, so every coverage and enforcement layer skips it.', fix: "Un-ignore the file, or untrack it (git rm --cached '<file>')." },
  'ambiguous-node-type': { severity: 'error', stage: 'coverage', meaning: 'With coverage.type_level on, an uncovered file matches two or more classifying types and the machine refuses to guess whose rules apply.', fix: "Give the file a node of the intended type, or narrow one of the types' when:." },
  'type-strict-orphan': { severity: 'error', stage: 'coverage', meaning: 'A file satisfies the when: of an enforce: strict type but belongs to no node of that type.', fix: 'Map the file to a node of that type.' },
  'type-strict-misplaced': { severity: 'error', stage: 'coverage', meaning: 'A file satisfies the when: of an enforce: strict type but is mapped by a node of another type.', fix: 'Move the file to a node of the strict type, or refactor it off that type\'s when:.' },
  'strict-overlap-conflict': { severity: 'error', stage: 'coverage', meaning: 'Files satisfy the when: of two enforce: strict types at once.', fix: "Narrow one of the two types' when: so each file belongs to one." },
  'coverage-required-shadowed': { severity: 'warning', stage: 'coverage', meaning: 'A plain coverage.required root sits entirely inside a plain coverage.excluded root; exclusion is absolute, so the required line can never make anything block.', fix: 'Remove the required line, or narrow the excluded root.' },

  // ── log ─────────────────────────────────────────────────────────────
  'log-entry-missing': { severity: 'error', stage: 'log', label: 'log-entry-missing', tier: 'T2', noun: 'node', meaning: 'A log_required node changed its own source without a fresh log entry (a rule, relation, lock or verdict change never owes one). Blocking on plain yg check; stops --approve only when the run would fill a pair of that node.', fix: 'yg log add --node <node> --reason "<why the change was made>"' },
  'log-cycle-open': { severity: 'warning', stage: 'log', meaning: "A log_required node's source moved past its recorded baseline and its newest entry keeps satisfying the requirement, because no full yg check --approve has recorded a new baseline (--only-deterministic never does).", fix: 'A full yg check --approve.' },
  'log-integrity': { severity: 'error', stage: 'log', meaning: "A node's (or a node type's) recorded log history was rewritten, or entries were inserted before its last recorded one (the shape a merge leaves).", fix: 'yg log merge-resolve --node <node> (or --type <type>) after a merge; otherwise restore log.md from version control.' },
  'log-format': { severity: 'error', stage: 'log', meaning: "A node's (or a node type's) log.md does not parse as log entries.", fix: 'Fix the lines the finding names, or restore the file from version control.' },
  'log-conflict': { severity: 'error', stage: 'log', label: 'log-conflict', tier: 'T2', noun: 'node', meaning: "A node's (or a node type's) log.md still carries git conflict markers.", fix: 'yg log merge-resolve --node <node> (or --type <type>)' },
  'type-law-unratified': { severity: 'error', stage: 'validate', decision: TYPE_LAW_STEP, meaning: "Under type_law.ratification: true, a rule stands enforced on a node type and its own log holds no ratification of the version that stands now for that type: law that reaches every file of a type is admitted by the user, and until then runs as advice. A changed rule needs a new ratification.", fix: "Ask the user. Admitted: yg log add --aspect <rule> --ratify --by '<who>' --reason '<what was admitted>'. Not admitted: status: advisory where the rule reaches the type." },
  'type-log-orphaned': { severity: 'warning', stage: 'log', meaning: 'A type log under .yggdrasil/types/ belongs to a node type yg-architecture.yaml no longer defines, so no context carries its decisions.', fix: 'Move the decisions that still hold to the type that replaced it (yg log add --type), then delete the directory — or restore the type.' },

  // ── fill: only a recording run reports these ────────────────────────
  'log-entry-required': { severity: 'error', stage: 'fill', meaning: 'yg check --approve stopped before filling anything: nodes it would fill pairs of owe a fresh log entry.', fix: 'Add the entries (yg log add), then re-run the same fill.' },
  'aspect-companion-runtime-error': { severity: 'by-status', stage: 'fill', label: 'aspect-companion-runtime-error', noun: 'pair', meaning: 'A companion.mjs failed at fill time (threw, returned a bad shape, resolved a missing or out-of-reach path, or its observations stayed inconsistent) — fail closed, no verdict written; plain yg check shows the pair as unverified.', fix: 'Fix companion.mjs (yg aspect-test --aspect <rule> --node <node> --dry-run shows what it resolves), then re-run the fill.' },

  // ── command errors (yg-error/1) ─────────────────────────────────────
  'usage': { severity: 'error', stage: 'command', meaning: 'A flag, argument or combination of them the command does not accept.', fix: 'yg <command> --help lists what it takes.' },
  'command-error': { severity: 'error', stage: 'command', meaning: 'A command refused for a reason no more specific code names; what, why and next say which.', fix: 'Follow the error\'s own next: line.' },
  'internal': { severity: 'error', stage: 'command', meaning: 'An error the CLI does not classify — a bug.', fix: 'File an issue with the command and its full output.' },
  'node-not-found': { severity: 'error', stage: 'command', meaning: 'The command names a node the graph does not hold. Every command that takes a node answers with it.', fix: 'yg find "<node>"' },
  'type-not-found': { severity: 'error', stage: 'command', meaning: 'The command names a node type yg-architecture.yaml does not define.', fix: 'Use a type the architecture defines (read .yggdrasil/yg-architecture.yaml).' },
  'aspect-not-found': { severity: 'error', stage: 'command', meaning: 'The command names a rule the graph does not hold. Every command that takes a rule id answers with it.', fix: 'yg aspects lists every rule id.' },
  'graph-missing': { severity: 'error', stage: 'command', meaning: 'There is no .yggdrasil/ graph in this directory or above it.', fix: 'yg init to create one, or run from the repository that has it.' },
  'graph-load-failed': { severity: 'error', stage: 'command', meaning: 'The graph could not be loaded at all (an unsupported or malformed schema version, an unreadable graph directory).', fix: 'Follow the error\'s next: line — usually yg init --upgrade, or upgrading the CLI.' },
  'lock-environment': { severity: 'error', stage: 'command', meaning: 'The lock cannot be written: another yg check --approve holds it, or writing it failed.', fix: 'Wait for the other run to finish (or remove its stale marker, as the error says), then re-run.' },
  'no-coverage': { severity: 'error', stage: 'command', meaning: 'yg context --file names a file that no node maps and no type covers.', fix: 'yg context --node <node>, or map the file to a node.' },
  'adopt-restore-failed': { severity: 'error', stage: 'command', meaning: 'yg adopt could not undo its own install after a failure, so a partly copied graph may be left in place.', fix: 'Restore the graph by hand as the error describes, then run yg adopt again.' },
  'node-path-invalid': { severity: 'error', stage: 'command', meaning: 'A --node value is not a node path: empty, absolute, climbing with .., or starting with model/.', fix: 'Write the path relative to .yggdrasil/model/, e.g. billing/cancel.' },
  'log-merge-not-in-progress': { severity: 'error', stage: 'command', meaning: 'yg log merge-resolve found no merge, rebase or cherry-pick in progress, and HEAD is not a merge commit, so there are no two sides to reconcile.', fix: 'Run it during the merge (or on the merge commit), or name the sides with --ours <ref> --theirs <ref>.' },
  'log-merge-log-missing': { severity: 'error', stage: 'command', meaning: 'yg log merge-resolve was asked about a node that has no log.md.', fix: 'Check the node path; a node with no log has nothing to reconcile.' },
  'log-merge-conflict-markers': { severity: 'error', stage: 'command', meaning: 'log.md still carries git conflict markers and no merge is in progress to write the union from.', fix: 'Remove the markers, keeping every entry of both sides ordered by datetime, then run yg log merge-resolve again.' },
  'log-merge-sides-unreadable': { severity: 'error', stage: 'command', meaning: 'yg log merge-resolve could not read log.md from the two sides of the merge (or from HEAD and the commit being replayed).', fix: 'Check that the refs exist locally (fetch them), then run it again.' },
  'log-merge-history-rewritten': { severity: 'error', stage: 'command', meaning: "The log's shared history was changed: the merged log does not start with what both sides share, the sides share no history, or one side or the replayed commit rewrote entries it had.", fix: 'Restore the shared entries unmodified (or restore the conflicted file and let yg log merge-resolve write it).' },
  'log-merge-entries-lost': { severity: 'error', stage: 'command', meaning: 'The merged log.md drops or alters entries one of the sides added.', fix: 'Restore the entries the error lists, byte for byte.' },
  'log-merge-entries-unknown': { severity: 'error', stage: 'command', meaning: 'The merged log.md holds entries neither side added — a merge may only union the two sides.', fix: 'Remove the entries the error lists.' },
  'log-merge-out-of-order': { severity: 'error', stage: 'command', meaning: 'The entries after the shared history are not in date order.', fix: 'Sort them by datetime, oldest first, each once.' },
  'log-merge-supersedes-conflict': { severity: 'error', stage: 'command', meaning: 'yg log merge-resolve found that both sides of the merge superseded the same entry, so two successors would both be in force; the union was written and its baseline recorded.', fix: 'Finish the merge, then add one entry that supersedes both successors and says which decision holds (yg log add ... --supersedes <a> --supersedes <b>).' },
  'log-supersedes-unknown': { severity: 'error', stage: 'command', meaning: 'yg log add --supersedes names a datetime that is not an entry of that log.', fix: 'Find the entry with yg log read ... --all and pass its exact datetime.' },
  'type-log-choice-missing': { severity: 'error', stage: 'command', meaning: 'yg log add --type was given neither --supersedes nor --adds while decisions are in force for the type or a type above it (the command lists them).', fix: 'Re-run with --supersedes <datetime> naming the entry the decision replaces, or --adds when it replaces none.' },
  'log-supersedes-superseded': { severity: 'error', stage: 'command', meaning: 'yg log add --supersedes names an entry a later entry already replaced.', fix: 'Supersede the entry that replaced it (named in the error) instead.' },
  'aspect-status-value-invalid': { severity: 'error', stage: 'command', meaning: 'yg log add --aspect --status names something that is not draft, advisory or enforced.', fix: 'Re-run with --status draft, advisory or enforced.' },
  'aspect-status-not-standing': { severity: 'error', stage: 'command', meaning: "yg log add --aspect --status records a status the rule's file does not carry — it records a change, it never makes one.", fix: "Set status: in the rule's yg-aspect.yaml first, then record it." },
  'aspect-status-evidence-missing': { severity: 'error', stage: 'command', meaning: 'yg log add --aspect --status was given no --evidence for the change.', fix: 'Re-run with --evidence "<what justified it>".' },
  'aspect-ratify-no-type': { severity: 'error', stage: 'command', meaning: 'yg log add --aspect --ratify names a rule no node type lists or implies, so there is no type law to admit.', fix: 'Record the note without --ratify: law raised on one component is the agent\'s own and needs no ratification.' },
  'aspect-ratify-by-missing': { severity: 'error', stage: 'command', meaning: 'yg log add --aspect --ratify was given no --by naming who admitted the rule.', fix: "Re-run with --by '<who admitted it>'." },
  'aspect-status-unchanged': { severity: 'error', stage: 'command', meaning: 'yg log add --aspect --status records the status the rule already stood at, so nothing changed.', fix: 'Record the note without --status, or change the status in the rule file first.' },

  // ── package: yg pack ────────────────────────────────────────────────
  'package-install-failed': { severity: 'error', stage: 'package', meaning: 'A package could not be copied into .yggdrasil/aspects/packages/.', fix: 'Fix what the error names (permissions, disk), then re-run the pack command.' },
  'package-manifest-missing': { severity: 'error', stage: 'package', meaning: 'A package directory has no yg-package.yaml.', fix: 'Point the pack command at a directory that holds yg-package.yaml.' },
  'package-symlink-refused': { severity: 'error', stage: 'package', meaning: 'A package carries a symbolic link; installing refuses it, and yg marketplace check reports it, because a copied link resolves against the consumer\'s file system.', fix: 'As the package author, replace the link with the file itself.' },
  'package-binary-file-refused': { severity: 'error', stage: 'package', meaning: 'A package carries a binary file; installing refuses it, and yg marketplace check reports it — a rule is text a reviewer and a consumer can read.', fix: 'As the package author, remove the binary file from the package.' },
  'packages-lock-invalid': { severity: 'error', stage: 'package', meaning: '.yggdrasil/yg-packages.yaml, the record of installed packages, is not valid YAML or its packages: is not a mapping.', fix: 'Restore yg-packages.yaml from version control.' },
  'packages-lock-schema-unknown': { severity: 'error', stage: 'package', meaning: 'yg-packages.yaml declares a schema this build does not know.', fix: 'Upgrade the CLI, or restore the file from version control.' },
  'packages-lock-package-invalid': { severity: 'error', stage: 'package', meaning: 'A record in yg-packages.yaml names an install directory that is not <owner>/<repo>/<package>.', fix: 'Restore yg-packages.yaml from version control.' },
  'packages-lock-entry-invalid': { severity: 'error', stage: 'package', meaning: 'A record in yg-packages.yaml is not a mapping, or holds a field value of the wrong form.', fix: 'Restore yg-packages.yaml from version control, or re-run yg pack add for the package.' },
  'packages-lock-entry-incomplete': { severity: 'error', stage: 'package', meaning: 'A record in yg-packages.yaml lacks a field every install writes.', fix: 'Re-run yg pack add for the package.' },
  'packages-lock-hash-invalid': { severity: 'error', stage: 'package', meaning: 'A record in yg-packages.yaml holds a file hash that is not a sha256 digest, or a files: that is not a mapping.', fix: 'Re-run yg pack add for the package.' },
  'packages-lock-path-escape': { severity: 'error', stage: 'package', meaning: 'A record in yg-packages.yaml names a file outside the package\'s install directory.', fix: 'Restore yg-packages.yaml from version control.' },

  // ── suppressions: yg suppressions ───────────────────────────────────
  'unknown-aspect': { severity: 'warning', stage: 'suppressions', meaning: 'A yg-suppress marker names a rule id the graph does not hold, so it waives nothing.', fix: 'Fix the rule id, or remove the marker.' },
  'wildcard': { severity: 'warning', stage: 'suppressions', meaning: 'A yg-suppress marker waives every rule at once.', fix: 'Name the one rule the waiver is for.' },
  'unbounded-range': { severity: 'warning', stage: 'suppressions', meaning: 'A yg-suppress marker opens a range that never closes, so it waives to the end of the file.', fix: 'Close the range where the waived code ends.' },
  'waives-under': { severity: 'warning', stage: 'suppressions', meaning: 'A yg-suppress marker waives a rule declared errs: under, which fires only on a provable violation — there is nothing about it to waive.', fix: 'Fix the flagged code, or correct the rule\'s errs label.' },
  'missing-reason': { severity: 'warning', stage: 'suppressions', meaning: 'A yg-suppress marker has no reason, so it waives nothing.', fix: 'Add the reason (the user approves it), or remove the marker.' },

  // ── marketplace: yg marketplace check, and the pack commands reading a marketplace ──
  'marketplace-manifest-missing': { severity: 'error', stage: 'marketplace', meaning: 'There is no yg-marketplace.yaml at the root being checked or installed from.', fix: 'yg marketplace init, or point the command at the repository that has one.' },
  'marketplace-manifest-invalid': { severity: 'error', stage: 'marketplace', meaning: 'yg-marketplace.yaml does not parse or does not validate.', fix: 'Fix the manifest as the finding says.' },
  'marketplace-schema-missing': { severity: 'error', stage: 'marketplace', meaning: 'yg-marketplace.yaml has no schema: line.', fix: 'Add schema: yg-marketplace/1.' },
  'marketplace-schema-unknown': { severity: 'error', stage: 'marketplace', meaning: 'yg-marketplace.yaml declares a schema this build does not know.', fix: 'Use schema: yg-marketplace/1, or upgrade the CLI.' },
  'marketplace-packages-invalid': { severity: 'error', stage: 'marketplace', meaning: "yg-marketplace.yaml's packages: is absent or not a list.", fix: 'Set packages: to a list of { name, path, version } (an empty list is legal).' },
  'marketplace-entry-invalid': { severity: 'error', stage: 'marketplace', meaning: 'A packages: entry is not a mapping, or its name is not a single path segment.', fix: 'Write the entry as { name, path, version } with a one-segment name.' },
  'marketplace-entry-duplicate': { severity: 'error', stage: 'marketplace', meaning: 'yg-marketplace.yaml lists one package name more than once.', fix: 'Remove or rename the duplicate entry.' },
  'marketplace-entry-escape': { severity: 'error', stage: 'marketplace', meaning: "A packages: entry's path leaves the marketplace root.", fix: 'Use a path inside the marketplace repository.' },
  'marketplace-entry-version-invalid': { severity: 'error', stage: 'marketplace', meaning: "A packages: entry's version is not semver.", fix: 'Set the version to a semver value.' },
  'marketplace-entry-missing': { severity: 'error', stage: 'marketplace', meaning: 'yg-marketplace.yaml publishes a package from a directory that has no yg-package.yaml.', fix: 'Add the package there, or fix the entry\'s path.' },
  'marketplace-dir-unlisted': { severity: 'error', stage: 'marketplace', meaning: 'A package directory in the marketplace is not listed in yg-marketplace.yaml.', fix: 'List it, or remove the directory.' },
  'package-name-mismatch': { severity: 'error', stage: 'marketplace', meaning: 'A package calls itself by another name than the marketplace publishes it under, or than its directory.', fix: 'Make the three names agree.' },
  'package-version-mismatch': { severity: 'error', stage: 'marketplace', meaning: 'A package declares another version than the marketplace publishes it as.', fix: 'Make the two versions agree.' },
  'package-aspect-invalid': { severity: 'error', stage: 'marketplace', meaning: 'A rule of a published package has no yg-aspect.yaml, ships both check.mjs and content.md, ships neither and implies nothing, or does not load.', fix: 'Fix the rule as the finding says.' },
  'package-implies-escapes': { severity: 'error', stage: 'marketplace', meaning: 'A rule of a published package implies a rule outside the package.', fix: 'Imply only the package\'s own rules.' },
  'package-config-undeclared': { severity: 'error', stage: 'marketplace', meaning: "A published rule reads a setting its package's config: does not declare.", fix: 'Declare the setting in yg-package.yaml, or stop reading it.' },
  'package-scope-literal-root': { severity: 'error', stage: 'marketplace', meaning: "A published rule's scope is anchored to a directory name of the author's repository, which a consumer's will not share.", fix: 'Scope the rule with a pattern that does not assume a root directory (e.g. **/).' },
  'package-review-by-present': { severity: 'error', stage: 'marketplace', meaning: 'A published rule declares review_by:, a date only the consumer may set.', fix: 'Remove review_by: from the published rule.' },
  'package-references-repo-path': { severity: 'error', stage: 'marketplace', meaning: "A published rule references a file of the author's repository, which the consumer will not have.", fix: 'Ship the file inside the rule\'s directory and reference it there.' },
  'package-drills-missing': { severity: 'error', stage: 'marketplace', meaning: 'A published rule has no drill cases, or not both a case it must refuse and one it must pass.', fix: 'Add drills/violates-… and drills/satisfies-… cases (yg drill add).' },
  'package-file-unreadable': { severity: 'error', stage: 'marketplace', meaning: 'A file of a published package could not be read.', fix: 'Make the file readable, then re-run the check.' },
  'package-config-unused': { severity: 'warning', stage: 'marketplace', meaning: "A package declares a setting its rule never reads.", fix: 'Remove the setting from config:, or read it in the rule.' },
  'package-config-dynamic': { severity: 'warning', stage: 'marketplace', meaning: 'A published rule reaches its settings through a name not written out in the source, so the check cannot tell which it reads.', fix: 'Read each setting by a literal name.' },
  'package-reviewer-tier': { severity: 'warning', stage: 'marketplace', meaning: "A published rule asks for a reviewer tier by name, which a consumer's configuration may not have.", fix: 'Remove reviewer.tier and let the consumer pick through an adaptation.' },
  'package-drills-unrecognized': { severity: 'warning', stage: 'marketplace', meaning: "A drills/ directory of a published rule is named neither violates-… nor satisfies-…, so no drill runs it.", fix: 'Rename it with the violates- or satisfies- prefix.' },
};

/** Every registered code, in the registry's order. */
export const ISSUE_CODES: readonly IssueCode[] = Object.keys(ISSUE_CODE_REGISTRY) as IssueCode[];

const BY_CODE: ReadonlyMap<string, IssueCodeEntry> = new Map(Object.entries(ISSUE_CODE_REGISTRY));

/**
 * The entry of `code`, or undefined when `code` is no registered code (an
 * outside twin, or a string from anywhere else). A Map lookup, so an arbitrary
 * string can never land on an inherited Object.prototype key.
 */
export function issueCodeEntry(code: string): IssueCodeEntry | undefined {
  return BY_CODE.get(code);
}
