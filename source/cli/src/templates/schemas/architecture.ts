export const content = `# yg-architecture.yaml — Schema for architecture constraints
# File: .yggdrasil/yg-architecture.yaml
#
# Defines the project's type system: what kinds of nodes exist, how they can
# relate, and which aspects apply by default. This is the foundation of the
# graph — every node declares a type, and every type must be defined here.
#
# Changes to this file affect the entire graph and should be confirmed with the user.
#
# Only node_types is accepted at the top level, and only the keys below inside a
# type; aspects and parents are lists (a single value is refused, not read as
# a one-entry list). Any other key fails the file (architecture-invalid) naming
# the key it is probably a typo of — a misspelled key used to be ignored,
# dropping the type system or the constraint it stated.

node_types:
  service:                                   # the type's name — what a node's type: names
    description: "A deployable backend service"  # required — what this type is for, when to use it.
                                             # absence is a FATAL architecture-invalid error (the whole type system is rejected).

    when: { path: "services/**" }            # optional — per-file classification (a file predicate).
                                             # Types WITH \`when\` are file-classifying: every file in
                                             # a node's mapping must satisfy the predicate (forward
                                             # check). Types WITHOUT \`when\` are organizational:
                                             # parent-only nodes — any mapping fires
                                             # type-without-when-with-mapping.
                                             #
                                             # Grammar:
                                             #   path: <glob>                — minimatch glob on repo-relative POSIX path
                                             #   content: <regex>            — JS regex against the file's first 256KB (a file >5MB can't be content-classified)
                                             #   path + content combined     — implicit all_of of both atoms
                                             #   all_of: [<predicate>, ...]  — every child must satisfy
                                             #   any_of: [<predicate>, ...]  — at least one child must satisfy
                                             #   not: <predicate>            — single child negation
                                             #
                                             # See: yg knowledge read working-with-architecture

    enforce: strict                          # optional — bidirectional enforcement.
                                             # Requires \`when\`. Every repo file matching the type's
                                             # \`when\` MUST belong to exactly one node of this type
                                             # (backward scan). A matching file owned by no such node
                                             # emits type-strict-orphan; one owned by a node of a
                                             # different type emits type-strict-misplaced.
                                             # Use only for types where missing the type means missing
                                             # a critical aspect (security, audit, regulatory) — a
                                             # per-type graduation dial, not a repo-wide milestone.
                                             # The backward scan accepts only an explicit node's
                                             # mapping as proof, never type-level coverage (coverage.type_level),
                                             # so a strict type's files never coast on automatic
                                             # type coverage the way a non-strict type's files can.

    log_required: true                       # optional — default false. Enable (true) on types whose
                                             # changes carry business intent worth capturing — domain
                                             # logic, command handlers, persistence adapters. When true,
                                             # a node of this type demands a fresh log entry before
                                             # \`yg check --approve\` whenever its mapped source changed
                                             # since the last full \`yg check --approve\` that closed its
                                             # cycle (--only-deterministic never closes one; yg check
                                             # warns log-cycle-open while none has). Leave omitted
                                             # (false) for types whose changes carry no business decision
                                             # worth forcing an entry for (e.g. config, types, constants).

    aspects:                                 # optional — aspects automatically applied to every
                                             # node of this type (channel 3). Two forms per entry:
      - audit-logging                        #   bare string — unconditional
      - id: pii-encryption                   #   object form — with per-site applicability filter
        status: enforced                     #   optional — explicit status override (channel 3).
                                             #   Must satisfy bump rule (bump up OK, downgrade is validator error).
        when: { node: { has_mapping: true } }  # optional — a node predicate; yg schemas read aspect has the grammar
                                             # These also cascade to children (channel 4).

    parents: [root, service]                 # optional — allowed parent node types in the hierarchy.
                                             # Absent: a node of this type may sit anywhere. Present:
                                             # only under a listed type; the reserved entry 'root'
                                             # allows the top level of model/ as well.

    relations:                               # optional — per-relation-type allow-list.
      # A relation type is constrained by listing its allowed target node types.
      #   uses: [domain, data-access]   → only those target types
      #   uses: ['*']                   → any target type
      #   uses: []                      → no target (relation type forbidden)
      #   (relation type omitted)       → governed by \`default\` below
      # default: allow | deny           → policy for relation types NOT listed.
      #   omitted ⇒ allow (every unlisted relation type may target any type).
      #   deny    ⇒ unlisted relation types target nothing (a sink).
      # Note: '*' is reserved as the any-target wildcard in relation lists and
      #   must not be used as a node-type name (the parser rejects it).
      # Examples:
      #   { default: deny }                       → pure sink
      #   { default: deny, listens: ['*'] }       → sink that may listen to anything
      #   { default: allow, uses: [] }            → everything open except \`uses\`
      uses: [service]
      default: allow
`;
