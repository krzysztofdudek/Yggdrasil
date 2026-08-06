export const summary = 'How to read yg-architecture.yaml: classifying vs organizational types, when grammar, enforce strict, pitfalls, type-suggest';

export const content = `# Working with the architecture file

The architecture file (\`yg-architecture.yaml\`) defines the project's
type system. Types classify source files via the \`when\` predicate.

## When to read this

You're editing \`yg-architecture.yaml\` and need to understand:
- How types classify files (forward + optional strict backward)
- How to write a \`when\` predicate (path + content atoms, operators)
- When to use \`enforce: strict\` vs forward-only
- Organizational types (no \`when\`, parent-only)

For port-based defense against cross-file evasion (channel 6) — a related
but distinct concern — see \`yg knowledge read ports-and-relations\`.

## Type kinds

Two kinds of types coexist:

1. **Classifying types** — have \`when\`. Files in mappings of nodes of this
   type must satisfy \`when\` (forward). With \`enforce: strict\`, every file
   in repo matching \`when\` must be in a mapping of this type (backward).

2. **Organizational types** — no \`when\`. Used as parent-only in the
   hierarchy. Nodes of this type cannot have non-empty \`mapping:\`.

## Predicate grammar

A type's \`when\` uses the FILE-atom family — \`path\` and \`content\` — with the
shared boolean combinators \`all_of\` / \`any_of\` / \`not\`. This is one of the three
sites of a single predicate grammar (the other file-atom site is an aspect's
\`scope.files\`; node-atom \`when:\` filters which NODES an aspect applies to). The
node atoms (\`node\`, \`relations\`, \`descendants\`) are NOT valid here — a type's
\`when\` classifies a single file. (Cross-site overview:
\`yg knowledge read conditional-aspects\`.)

### path atom
\`\`\`yaml
when:
  path: "src/cli/**/*.ts"
\`\`\`

Matches files whose repo-relative path matches the glob.

### content atom
\`\`\`yaml
when:
  content: "register[A-Z]\\\\w*Command"
\`\`\`

Matches files whose content satisfies the regex.

### Combining: all_of, any_of, not
\`\`\`yaml
when:
  all_of:
    - path: "src/cli/**/*.ts"
    - content: "register[A-Z]\\\\w*Command"
    - not:
        path: "**/*.test.ts"
\`\`\`

## When to use enforce: strict

Use \`enforce: strict\` for types carrying critical aspects (security,
auditing, etc) where missing the type means missing the aspect. Strict
guarantees coverage in both directions: forward — every file in a mapping
of this type must satisfy \`when\` — and strict backward — every file in the
repo matching \`when\` must be in a mapping of this type (and of the right
type). Closes the type-shopping evasion entirely for the type.

Treat it as a per-type graduation dial, not a repo-wide milestone: flip it
on the one or two types where an explicit, reviewable node has to exist
every time, and leave the rest alone. This holds even when
\`coverage.type_level\` is on for the rest of the architecture — the backward
scan only ever accepts an explicit node's mapping as proof of coverage,
never the type-level lattice, so a strict type never lets a matching file
coast on automatic type coverage the way a non-strict type's files do.

The backward check honors \`coverage.excluded\` like every other coverage
question: a file under an excluded root is never a \`type-strict-orphan\` or
\`type-strict-misplaced\` candidate, even when it matches \`when\`. An excluded
path is gone from this graph's coverage entirely, not merely from the
ordinary required/advisory tiering.

Don't use \`enforce: strict\` when the \`when\` predicate is broad (e.g.
\`path: "**"\`) — every repo file would be required in that type's mapping.

Strict enforcement fires these error codes:
- \`enforce-strict-without-when\` — a type declares \`enforce: strict\` with no
  \`when\` predicate (strict needs \`when\` to know which files it must enforce
  against; without one there is no condition to evaluate)
- \`type-strict-orphan\` — file matches \`when\` but is in no mapping
- \`type-strict-misplaced\` — file matches \`when\` but is in a wrong-type mapping
- \`strict-overlap-conflict\` — a file matches the \`when\` of TWO strict types, so
  neither can own it unambiguously (resolve by narrowing one type's \`when\`)

They are reported alongside \`unmapped-files\` when applicable — distinct symptoms
with distinct fixes, no de-duplication.

## Pitfalls

- **Overly broad when**: \`path: "**"\` matches everything. Useful for
  placeholder during migration, dangerous in production strict mode.
- **Forgotten not**: command type without \`not: { path: "**/*.test.ts" }\`
  will reject test files that happen to call command APIs.
  For centralized test directories (e.g. \`tests/\`), exclude with
  \`not: { path: 'tests/**' }\` instead of (or in addition to) the
  per-file \`*.test.ts\` negation.
- **Mixing organizational with classifying parents**: a classifying type's
  parents can include organizational types (they're allowed as parents
  in the hierarchy). Validator imposes no semantic restriction.
- **Narrow content regex**: a content predicate that is too specific may
  fail to match valid files when implementation details change.

## Type-suggest workflow

Use \`yg type-suggest --file <path>\` to verify that a file would be
classified correctly under the defined predicates:

\`\`\`bash
yg type-suggest --file src/orders/handler.ts
\`\`\`

Output shows matching types (✓), closest non-matching types ranked by
predicate satisfaction fraction, types whose \`content:\` predicate could not
be evaluated at all (e.g. the file exceeds the content-scan size limit —
listed separately as unreadable rather than folded into a non-match, and
never implying the file is blocked), or edge-case messages for files inside
\`.yggdrasil/\` or for non-existent files (path-only check).

Run this whenever you add or modify a type's \`when\` predicate and want
to verify that existing files are classified as expected.

## Glob patterns in mapping and when.path

Both node \`mapping:\` entries and architecture \`when.path\` predicates accept
minimatch glob patterns. \`*\` matches any characters within a single path
segment (does not cross \`/\`); \`**\` matches across path segments.

Examples:
- \`src/db/*Repository.cs\` — owns only files matching \`*Repository.cs\` directly
  inside \`src/db/\`, not subdirectory files or non-matching files like \`Helper.cs\`.
- \`src/**/*.ts\` — owns all \`.ts\` files anywhere under \`src/\` at any depth.

Plain (non-glob) entries remain unchanged: an exact file path or a directory
prefix (e.g. \`src/handlers\`) covers that file or all files beneath it.

## Allowed relations and default policy

A node type may also set \`relations.default: deny\` to forbid every relation type it does not explicitly list (a sink), open a single relation type to any target with \`['*']\`, or forbid one with an empty list \`[]\`. An omitted \`default\` means allow.

## log_required — when to enable the log gate

Each node type may set \`log_required\` (default \`false\`). When \`true\`, a node of
that type demands a fresh log entry whenever its mapped source changed since the
node's last positive closure. The requirement is a property of the node TYPE plus
a source change — independent of the node's aspects or pairs — and is enforced
read-only: plain \`yg check\` flags a missing entry as a blocking error, so it
bites even on a node that produces no pairs (the log gate, see \`yg knowledge read
log-management\`).

Enable it on types whose changes carry business intent worth capturing —
domain logic, command handlers, persistence adapters, anything where the WHY
behind a change matters to the next agent. Leave it off (the default) for types
whose changes carry no business decision worth forcing an entry for —
configuration, generated artifacts, pure type definitions, test scaffolding.

\`\`\`yaml
node_types:
  command:
    description: "CLI command handler"
    when:
      path: "src/commands/**/*.ts"
    log_required: true        # changes here carry intent — force an entry
  types:
    description: "Shared type definitions"
    when:
      path: "src/types/**/*.ts"
    # log_required omitted → false: no entry forced
\`\`\`

## Aspect status in architecture default aspects

Architecture-level default aspects (channel 3) may declare \`status:\` to
control the enforcement level. When a node_type in \`yg-architecture.yaml\`
declares a default aspect with status, that status applies to every node of
that type unless explicitly overridden at the node or channel level.
See: \`yg knowledge read aspect-status\`.
`;
