export const summary = 'Aspect definition — reviewer kind, scope, status, review_by, errs, implies, references, when.';

export const content = `# yg-aspect.yaml — Schema for cross-cutting aspects
# Each aspect is a directory under .yggdrasil/aspects/ containing this file
# plus any number of .md content files (for LLM aspects) or a check.mjs
# (for deterministic aspects).
#
# Aspect identifier = relative path from aspects/ to the directory
# (e.g. observability/logging). Aspects can be organized in nested
# directories — the directory structure is for organization only,
# there is no automatic parent-child inheritance between aspects.
#
# The .md content files are what the reviewer checks against source code.
# They should state WHAT must be satisfied and WHY.

name: CrossCuttingRequirementName  # required — display name
description: "Short description"   # required — shown in yg aspects output and context packages.
                                   # Validator emits description-missing if absent.

# reviewer:                        # OPTIONAL — reviewer kind is inferred from rule-file presence:
                                   #
                                   #   content.md present          → llm
                                   #   check.mjs present           → deterministic
                                   #   neither + implies declared  → aggregate
                                   #
                                   # The reviewer: block is only required when you need to declare
                                   # reviewer.tier: for an LLM aspect. When present, an explicit
                                   # reviewer.type must agree with the inferred kind (validator
                                   # error otherwise).
                                   #
                                   # Three kinds:
                                   #   llm           — aspect ships content.md; an LLM reads it and
                                   #                   judges the code against the rule.
                                   #   deterministic — aspect ships check.mjs; the runner executes it
                                   #                   locally with graph-aware ctx (files, fs, graph,
                                   #                   parsers). Language-agnostic. No LLM call, zero
                                   #                   token cost.
                                   #   aggregate     — aspect ships neither rule source but declares
                                   #                   implies:. A named bundle — expands its implied
                                   #                   aspects onto every node where effective. Has no
                                   #                   own reviewer and produces no own verdict. An
                                   #                   aspect with neither rule source and no implies:
                                   #                   is rejected (aspect-empty).
  # type: llm                      #   optional; must be 'llm', 'deterministic', or 'aggregate' if set.
  # tier: deep                     #   optional, only when type: llm (or inferred llm).
                                   #     If omitted, the aspect uses reviewer.default from yg-config.yaml.
                                   #     If present, must reference a key under reviewer.tiers in the config.
                                   #     Forbidden when type is 'deterministic' or 'aggregate'.

status: enforced                   # optional — aspect-level default. enum: draft | advisory | enforced.
                                   # Absent → 'enforced'.
                                   # draft     = reviewer skipped, no verdict, no baseline, no drift.
                                   # advisory  = reviewer runs; refused → warning (no block).
                                   # enforced  = reviewer runs; refused → error (blocks check).
                                   # This is only the aspect-level default. The effective status on a
                                   # node is max() across cascading channels 1–6; channel 7 (implies)
                                   # carries status_inherit instead. Downgrade attempts are validator
                                   # errors. Advisory and enforced verdicts are recorded in the
                                   # baseline; draft aspects get no verdict.

# review_by: 2027-01-15            # optional — a standing review-by date (bare ISO
                                   # calendar date YYYY-MM-DD). It is the constitution's
                                   # request to re-examine whether this rule still earns
                                   # its place by that day.
                                   # Valid on ANY aspect kind (llm | deterministic |
                                   # aggregate) and independent of status — review cadence
                                   # is about the rule's continued relevance, not its
                                   # reviewer kind or enforcement level.
                                   # When present it must be a real calendar date
                                   # (2027-02-30 / 2027-13-01 are rejected); a malformed
                                   # value is a blocking error (aspect-review-by-malformed),
                                   # fired ONLY on the aspect that carries it.
                                   # Once the date has passed, yg check emits ONE advisory
                                   # warning (aspect-review-overdue) asking you to renew or
                                   # retire the rule — it NEVER changes the date itself and
                                   # never blocks a build.
                                   # NEVER folded into any verdict hash: recording or
                                   # changing review_by re-verifies nothing. Absent →
                                   # undefined (no review-cadence tracking).

# errs: under                      # optional — the error-direction of a DETERMINISTIC check.
                                   # enum: over | under | exact. Legal ONLY on deterministic aspects
                                   # (declaring errs on an llm/aggregate aspect is a validator error).
                                   # Absent → undefined.
                                   #   over  = the check may flag code the rule does not forbid
                                   #           (false positives possible).
                                   #   under = the check only ever fires on provable violations
                                   #           (no false positives by design).
                                   #   exact = the check neither over- nor under-approximates.
                                   # This is rendering/analysis metadata only. It is NEVER folded into
                                   # any verdict hash — labeling or relabeling errs re-verifies nothing.
                                   # \`yg suppressions\` warns when a waiver targets an errs: under check,
                                   # since such a check has no false positives to waive.

# implies:                         # optional — other aspects included automatically when this
#                                  # aspect is effective on a node. Two forms:
#   - simple-aspect-id             # bare string — implied unconditionally (when outer aspect passes)
#   - id: conditional-aspect-id    # object form — imply only when \`when\` passes on the node
#     when: <predicate>            # see \`when\` section below for grammar
#     status_inherit: strictest    # optional — propagation modifier for this implies edge.
                                   # enum: strictest | own-default.
                                   # Absent → 'strictest' (implied aspect promotes to
                                   # the implier's effective status if higher than the
                                   # implied aspect's own default).
                                   # 'own-default' anchors the implied aspect to its
                                   # own aspect-level default (decouples from implier).
                                   #
                                   # ASYMMETRY NOTE: attach-site entries on channels
                                   # 1–6 (node, ancestor, architecture type, ancestor
                                   # type, flow, port) carry an explicit \`status:\`
                                   # VALUE. Channel 7 (implies) carries a propagation
                                   # MODIFIER (\`status_inherit:\`) instead. Implies is
                                   # not a direct attach — the implied aspect's status
                                   # is structurally derived from the implier's
                                   # effective status on the node. The modifier
                                   # selects how to derive; a value-overriding
                                   # \`status:\` on an implies edge would couple the
                                   # edge to a literal that becomes stale if the
                                   # implied aspect's own default changes.
                                   # Chains expand recursively. Cycles are forbidden — CLI detects.

# when: <predicate>                # optional — applicability filter. If the predicate evaluates
                                   # to false on a node, this aspect is not effective on that node
                                   # regardless of which channel attached it. Combines with
                                   # attach-site \`when\` declarations via AND.
                                   #
                                   # Grammar:
                                   #   when:
                                   #     all_of: [<clause>, ...]    # AND
                                   #     any_of: [<clause>, ...]    # OR
                                   #     not: <clause>              # negation
                                   #     <atomic>                   # top-level atomics imply all_of
                                   #
                                   # Atomic clauses:
                                   #   relations:
                                   #     <relation-type>:           # calls | uses | extends | implements | emits | listens
                                   #       target_type: <type-id>   # match target node's declared type
                                   #       target: <node-path>      # match exact node path (relative to model/)
                                   #       consumes_port: <port>    # match a port consumed on this relation
                                   #   descendants:                 # same as relations but evaluated against any descendant in model/
                                   #     relations: {...}
                                   #     type: <type-id>
                                   #     has_port: <port-name>
                                   #   node:
                                   #     type: <type-id>
                                   #     has_port: <port-name>
                                   #     has_mapping: true | false
                                   #
                                   # Example:
                                   #   when:
                                   #     any_of:
                                   #       - relations: { calls: { target_type: service-client } }
                                   #       - descendants: { relations: { calls: { target_type: service-client } } }

# scope:                            # optional — controls review granularity (applies to both LLM
                                   # and deterministic aspects). Forbidden on aggregate aspects.
                                   # Absent → equivalent to { per: node }.
                                   #
                                   # Fields:
                                   #   per: node | file     REQUIRED. Default: node.
                                   #     node — one review over the whole subject set.
                                   #            LLM: one prompt with all subject files.
                                   #            Deterministic: one check(ctx) invocation; ctx.files = subject set.
                                   #     file — one review per subject file.
                                   #            LLM: one prompt per file.
                                   #            Deterministic: one check(ctx) invocation per file; ctx.files = [file].
                                   #            WARNING: per: file is ONLY for file-local rules — a per-file
                                   #            reviewer cannot see sibling files. Rules that need cross-file
                                   #            context (e.g. "correlation ID propagates across calls") must
                                   #            stay per: node. Before switching an aspect to per: file, verify
                                   #            the rule can be judged from that single file alone.
                                   #
                                   #   files: <file-predicate>   OPTIONAL. Filters which mapped files enter
                                   #     the subject set. Subject set = mapped files ∩ filter.
                                   #     Absent → all mapped files.
                                   #     Empty subject set after filtering → vacuous pass by design (no review,
                                   #     no error). An aspect may legitimately exclude every file of a node it
                                   #     lands on (e.g. a filter that matches only *.ts files landing on a
                                   #     node with only *.py files).
                                   #
                                   #     File-predicate grammar — atoms:
                                   #       path: "glob"        minimatch glob on repo-relative POSIX path
                                   #       content: "regex"    JavaScript regex tested against file content
                                   #     Boolean combinators (same as aspect when:):
                                   #       all_of: [...]       AND
                                   #       any_of: [...]       OR
                                   #       not: <clause>       negation
                                   #     Top-level path + content imply all_of.
                                   #
                                   #     NOTE: path/content are FILE atoms — they belong here in scope.files.
                                   #     The aspect-level when: field uses NODE atoms (node, relations,
                                   #     descendants) and filters which NODES the aspect applies to — do not
                                   #     mix the two. The CLI will cross-hint you if you use an atom in the
                                   #     wrong site.
                                   #
                                   # Cost note: editing scope: (per or files) changes the input hash for
                                   # every pair of this aspect — every node using the aspect needs
                                   # re-verification. Run \`yg impact --aspect <id>\` before widening or
                                   # narrowing the filter.
                                   #
                                   # Example:
                                   #   scope:
                                   #     per: file
                                   #     files:
                                   #       all_of:
                                   #         - path: "src/**/*.ts"
                                   #         - not: { path: "**/*.test.ts" }

# references:                      # optional — supporting files for the LLM reviewer.
                                   #   Permitted on LLM aspects ONLY (forbidden on deterministic).
                                   #   Each entry is a string (shorthand) OR an object { path, description? }.
                                   #
                                   # Example:
                                   #   references:
                                   #     - docs/error-codes.md                    # shorthand
                                   #     - path: source/cli/src/errors/codes.ts
                                   #       description: "Catalogue of valid error codes; reviewer rejects unknown codes."
                                   #
                                   # Constraints (validated by \`yg check\`):
                                   #   - Path is repo-root-relative.
                                   #   - No '..' that escapes the repo root; no leading '/'; no Windows drive letter; no '~'.
                                   #   - File must exist at check time and resolve (after symlink follow) to a regular file.
                                   #   - No duplicates within one aspect.
                                   #
                                   # Drift semantics: changes to referenced files cascade to all nodes where this
                                   # aspect is effective — same as changes to content.md. Run \`yg impact --file <ref>\`
                                   # before editing a widely-referenced file.
                                   #
                                   # Size limits: there is NO per-tier reference byte cap. Reference bytes count
                                   # toward the assembled reviewer prompt, bounded by reviewer.tiers.<name>.max_prompt_chars
                                   # (default 50000) in yg-config.yaml; an over-limit pair is a blocking prompt-too-large
                                   # error with remedies (see yg knowledge read writing-llm-aspects).

# companion.mjs                   # OPTIONAL — per-unit companion file resolver. LLM aspects ONLY.
                                   # Requires content.md (validator error aspect-companion-without-content
                                   # if companion.mjs is present without content.md). Forbidden alongside
                                   # check.mjs (validator error aspect-companion-with-check). This is an
                                   # ADD-ON to the LLM reviewer kind, not a new reviewer kind; reviewer
                                   # kind inference is unchanged.
                                   #
                                   # Contract:
                                   #   export function companion(ctx) { ... }  // may be async
                                   #   // Returns Array<{ path: string, label?: string }>
                                   #
                                   # The hook runs once per unit, BEFORE the LLM call. It selects 0..N
                                   # companion files that are injected into the reviewer prompt for that
                                   # unit only (companion files differ per unit; static supporting files
                                   # use references: instead).
                                   #
                                   # ctx mirrors the deterministic check ctx PLUS:
                                   #   ctx.subject — the unit's subject files. Always File[].
                                   #     scope.per: file → single-element array [file].
                                   #     scope.per: node → the full subject set (same as ctx.files).
                                   # Read boundaries: same as check.mjs (own mapping, declared-relation
                                   # targets, ancestors, own descendants). Attempting to read outside
                                   # this set is an allowed-reads violation and causes an infra-fail.
                                   # Read the single needed file via ctx.fs.read/ctx.fs.exists;
                                   # materializing a related node via ctx.graph folds that node's
                                   # entire content into every per-file pair (breaks per-unit
                                   # isolation).
                                   #
                                   # Returned paths:
                                   #   Absolute or relative paths. The runner normalizes each to
                                   #   repo-root-relative POSIX, deduplicates, and sorts.
                                   #   For scope.per: node, a returned path equal to a unit subject
                                   #   file is silently skipped and NOT recorded as touched.
                                   #
                                   # Return [] to indicate no companions for this unit (valid — the
                                   # unit is reviewed with subject files only).
                                   #
                                   # Throw to assert a requirement that cannot be satisfied —
                                   # the throw becomes a companion-runtime-error (nothing written,
                                   # pair stays unverified, reported as aspect-companion-runtime-error).
                                   #
                                   # Assembly failure — hook throws, bad return shape, a returned path
                                   # does not exist, a path outside the allowed-reads set, or
                                   # observations stayed inconsistent across two runs — is a
                                   # companion-runtime-error, counted and summarized separately from
                                   # provider/infra failures. The hook never judges code; it only
                                   # resolves paths.
                                   #
                                   # yg-suppress markers in companion files are IGNORED — suppression
                                   # is scoped to subject files only.
                                   #
                                   # companion.mjs appears in the aspect's read: listing (yg context).
                                   #
                                   # Hashing:
                                   #   companionHash: sha256(companion.mjs bytes) — folded into
                                   #     inputHash when the aspect ships companion.mjs, regardless of
                                   #     whether the hook resolves any files for a given unit. Editing
                                   #     companion.mjs re-verifies ALL pairs of the aspect.
                                   #   touched: hook's file observations beyond the subject set —
                                   #     also appears on companion-bearing LLM entries (not only
                                   #     deterministic entries). The verdict folds every
                                   #     out-of-subject file the hook reads to decide, not only
                                   #     the paths it returns — editing any such file re-verifies
                                   #     its readers.
                                   #
                                   # Lock version remains 1 — no schema/format bump.
                                   # yg impact --file <file> previews the precise companion
                                   # blast radius, including cold companion-LLM pairs (it runs
                                   # the resolver, no LLM call).
`;
