export const summary =
  'One predicate grammar, three sites (when:, architecture node_types.*.when, scope.files), shared combinators, node atoms vs file atoms, cross-hints';

export const content = `# Conditional aspects (when predicate)

The \`when\` predicate filters applicability. Every propagation channel passes
through \`when\` before an aspect becomes effective on a node. If \`when\` is
false, the aspect is silently skipped on that node — no verification, no cost.

## One grammar, three sites

There is ONE predicate grammar: a parser with the boolean combinators
\`all_of\` / \`any_of\` / \`not\`, shared everywhere. Two atom families exist; the
SITE determines which atoms are legal, because each site asks about a different
subject.

| Site | What it filters | Subject | Atom family |
|---|---|---|---|
| aspect \`when:\` (all attach sites + \`implies\` edges) | which NODES the aspect applies to | a node | \`node\`, \`relations\`, \`descendants\` |
| \`yg-architecture.yaml\` → \`node_types.*.when\` | which FILES a type classifies | a file | \`path\`, \`content\` |
| aspect \`scope.files\` | which FILES are the review subject | a file | \`path\`, \`content\` |

The combinators are interchangeable across sites; the atoms are NOT. A node atom
(\`node\`, \`relations\`, \`descendants\`) is legal only where the subject is a node;
a file atom (\`path\`, \`content\`) only where the subject is a file. Using the wrong
family is a validator error, and the message cross-hints the sibling site
("\`path\` is a file atom — not valid in \`when:\`. To filter which FILES are
reviewed use \`scope.files:\`; \`when:\` filters which NODES the aspect applies to").
Reference-integrity validation of named identifiers (\`when-unknown-*\`) is
unchanged.

This document is about aspect \`when:\` (node applicability) unless a section is
explicitly labelled file-when.

## Why use when

Without \`when\`, attaching an aspect to a type or parent node applies it to
every node of that type or every descendant. That is often too broad.

Examples where aspect \`when\` helps:
- \`external-api-error-mapping\` attached to a command type, but only when the
  command actually calls a service client.
- \`pii-encryption\` on all repository nodes, but only when the node has a
  mapping (skip organizational parents that own no files).
- \`correlation-tracking\` only on nodes that consume a specific port.

## Aspect-level when grammar

\`\`\`yaml
when:
  all_of: [<clause>, ...]    # AND — every clause must pass
  any_of: [<clause>, ...]    # OR — at least one clause passes
  not: <clause>              # negation of a single clause
  # Or top-level atomic clauses (multiple atoms at the top level imply all_of):
  node:
    type: <type-id>          # node is exactly this type
    has_port: <port-name>    # node declares this named port
    has_mapping: true|false  # node owns at least one mapped file (or owns none)
  relations:
    <relation-type>:         # calls | uses | extends | implements | emits | listens
      target_type: <type-id> # at least one relation of this type targets a node of this type
      target: <node-path>    # ...or targets exactly this node path (relative to model/)
      consumes_port: <port>  # ...or consumes this port on the relation
  descendants:               # same checks, but satisfied by ANY hierarchical descendant
    type: <type-id>
    has_port: <port-name>
    relations: { <relation-type>: { target_type: <type-id> } }
\`\`\`

Rules the parser enforces:
- A relation-type entry must carry a match. \`relations: { emits: {} }\` is
  rejected — give at least one of \`target_type\`, \`target\`, or
  \`consumes_port\`. A relation clause means "at least one relation of that type
  satisfies the match"; there is no count operator.
- A \`node\`, \`relations\`, or \`descendants\` clause must carry at least one
  inner field; an empty clause is rejected.
- At a single level, use EITHER one boolean operator OR atomic clauses — not
  both, and at most one boolean operator. To combine more, nest another level.

Beyond these structural checks, \`yg check\` reference-integrity-validates the
identifiers a \`when\` predicate names. These are error-severity:
- An unknown \`target_type\`, \`descendants.type\`, or \`node.type\` raises a
  \`when-unknown-type\` error.
- An unknown relation \`target\` (a node path that does not exist) raises a
  \`when-unknown-node\` error.
- An unknown \`consumes_port\` raises a \`when-unknown-port\` error.

### A node calls a service client

\`\`\`yaml
when:
  relations:
    calls:
      target_type: service-client
\`\`\`

### A node OR any of its descendants calls a service client

OR is expressed with \`any_of\` — NOT by creating separate attach sites:

\`\`\`yaml
when:
  any_of:
    - relations:    { calls: { target_type: service-client } }
    - descendants:  { relations: { calls: { target_type: service-client } } }
\`\`\`

### A command that owns files but is not a generated stub

\`\`\`yaml
when:
  all_of:
    - node: { type: command, has_mapping: true }
    - not:
        node: { has_port: generated }
\`\`\`

### A consumer of a specific port

\`\`\`yaml
when:
  relations:
    calls:
      consumes_port: charge
\`\`\`

## Applicability examples by attach site

**Architecture default applied only to a node type that calls payments:**
\`\`\`yaml
# yg-architecture.yaml, node_types.command.aspects
aspects:
  - id: audit-logging
    when:
      relations:
        calls:
          target: payments/service
\`\`\`

**Aspect-global when (precondition wherever attached):**
\`\`\`yaml
# aspects/idempotency-key/yg-aspect.yaml
when:
  relations:
    emits:
      target_type: event-bus
\`\`\`

**Per-attach-site when on a node:**
\`\`\`yaml
# yg-node.yaml aspects
aspects:
  - id: pii-encryption
    when:
      node: { has_mapping: true }
\`\`\`

## File atoms — scope.files and architecture classification

Both file-atom sites use the SAME atoms — \`path\` and \`content\` — and the same
combinators. The node/relations/descendants atoms are NOT available here.

**\`scope.files\` on an aspect** narrows which mapped files are the review subject:

\`\`\`yaml
# yg-aspect.yaml
scope:
  per: node
  files:
    all_of:
      - path: "src/**/*.ts"        # minimatch glob on repo-relative POSIX path
      - not: { path: "**/*.test.ts" }
\`\`\`

**\`node_types.*.when\` in the architecture** decides which files a type owns:

\`\`\`yaml
node_types:
  command:
    when:
      all_of:
        - path: "src/handlers/**"
        - content: "export class"   # JavaScript regex tested against file content
\`\`\`

A bare \`path\` plus \`content\` at the top level implies \`all_of\` of both atoms.
(File classification deep dive: \`yg knowledge read working-with-architecture\`.)

## Propagation through channels

Aspect-global \`when\` (on the aspect definition) and per-attach-site \`when\`
(on the channel's list entry) combine via AND for each channel path.

The aspect is effective on a node if ANY channel's path passes BOTH its
global and its attach-site filter. Channels deliver independently: if an
aspect is directly attached to a node with no \`when\` (channel 1) AND also
delivered via an ancestor with a \`when\` (channel 2), it is effective from
channel 1 regardless of whether channel 2's filter passes.

\`yg context --node <path>\` shows effective aspects with their channel source.
An aspect silently skipped because \`when\` was false does not appear in the
effective list — that is correct behavior.

## Applicability for a file enforced only by its type

A source file with no explicit component of its own — covered by \`coverage.type_level\`
through its matched architecture type alone — still answers a \`when:\` predicate,
against a fixed set of total facts:

- \`node.type\` is the matched type id.
- \`node.has_mapping\` is always \`true\` — the file maps exactly one subject, itself.
- \`node.has_port\` is always \`false\` — a file-level unit cannot own a port, so any
  aspect gated on \`has_port\` is attached-but-never-applicable for it, not silently
  absent.
- \`descendants:\` is always \`false\` — a file-level unit has no hierarchy below it.
- A \`relations:\` atom is answered from a statically-resolved import leaving the
  file, not from a declared node relation (a type-covered file has none). One
  resolved import is evidence for \`uses\`, \`calls\`, \`extends\`, and \`implements\`
  alike — dependency analysis cannot tell calling from using from extending from
  implementing, so a single import satisfies a \`relations:\` clause naming any of
  the four the same way. An import is never evidence of an \`emits\` or \`listens\`
  relation, and never evidence of a \`consumes_port\` — those atoms always read
  false for a type-covered file, regardless of what it imports.

This makes applicability for such a file volatile in a way a declared component
is not: a rule whose applicability depends on what a file imports can start or
stop applying because the OTHER end changed — the imported file was re-typed, or
gained or lost a component of its own — even though the file itself was not
edited. When that happens the rule's stored result is discarded, the same way it
is discarded when an applicability condition is edited. Nothing is lost silently:
the run that discards it says so.

## Cost

\`when\` evaluation is deterministic — no LLM call. It runs at \`yg check\` time
and is essentially free. Use it freely to narrow applicability; it is cheaper
than letting the reviewer decide by reading code.

Prefer \`when\` over splitting types (fewer types, same precision). Prefer
\`when\` over leaving applicability decisions inside \`content.md\` prose.

\`when\` applicability acts through the expected-pair set, not through
invalidation: a \`when\` edit that changes a node's applicability adds or removes
that node's pairs; one that does not change applicability re-verifies nothing.

## When vs status

Applicability (\`when\` predicate) is distinct from enforcement level
(\`status: draft | advisory | enforced\`). A \`when\` filter determines WHETHER
an aspect reaches a node. Status determines how a verdict renders once it does.
To PARK an aspect, use \`status: draft\`, not a \`when\` edit — garbage-collection
prunes when-excluded pairs but keeps draft pairs. See:
\`yg knowledge read aspect-status\`.
`;
