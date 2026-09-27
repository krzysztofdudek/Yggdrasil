import { RELATION_CARRIES_PORT_ASPECTS } from './shared-text.js';

export const summary = 'Six relation types, paired events, ports propagate aspects via channel 6 through a named port or the implicit default, port-undefined/port-missing-aspect errors, empty portNames as a yaml-invalid parse failure, built-in relation-conformance check';

export const content = `# Ports and relations

Relations express typed dependencies between nodes. Ports propagate aspects
across those dependencies — that is channel 6 of the seven aspect channels.

Mental model. ${RELATION_CARRIES_PORT_ASPECTS} When a critical aspect must hold
on both sides of a call, put it on a port: on \`default\` for every caller that
names no port, or on a named port for the callers that name it.

## Relation types

Six types split into two groups:

**Structural** — how code is composed:
- \`calls\` — node A invokes a function/method of B
- \`uses\` — node A depends on B's data/state
- \`extends\` — node A extends B (e.g. class inheritance)
- \`implements\` — node A implements B's interface/contract

**Event-based** — async / decoupled:
- \`emits\` — A emits events
- \`listens\` — A listens for events

Event relations must be paired: if A emits to B, B must declare a
\`listens\` from A. \`yg check\` enforces this.

## Architecture controls allowed relations

Architecture controls which relation types are allowed between which node types. By default a relation type is unconstrained — it may target any node type. A type constrains a relation type by listing its allowed targets (e.g. \`uses: [domain, data-access]\`); the validator then rejects any target not in that list. Three more controls let you lock a type down: \`default: deny\` makes every unlisted relation type target nothing (a sink); an empty list \`uses: []\` forbids that one relation type entirely; and the wildcard \`uses: ['*']\` opens a relation type to any target (useful under \`default: deny\`). An omitted \`default\` means allow, so existing graphs are unaffected.

When a needed relation is not allowed by the architecture:
1. Use a different relation type that IS allowed
2. Change one node's type
3. Update the architecture to permit the relation (requires user
   confirmation — never silent)

## Relation-conformance check — declared relations must cover real dependencies

Every \`yg check\` (plain or \`--approve\`) runs a built-in, deterministic check that
holds the graph's relation edges to the code's actual dependencies. It parses
every mapped source file (TypeScript/JS/TSX, the \`<script>\` blocks of Vue and
Svelte components, Python, Go, Java, PHP, Kotlin, Rust, C, C++, C#, Ruby), finds
each statically-resolvable dependency on ANOTHER node's code, and refuses a node
that depends on a node it does not declare a relation to. The issue code is
\`relation-undeclared-dependency\`. A type-only reference (\`import type\`,
\`export type … from\`, \`typeof import('./m')\`, a type argument) is a dependency
exactly like a value import. Where an import lands depends on the language and
the build layout (tsconfig \`paths\`, \`go.mod\`, \`pyproject.toml\`, Cargo path
dependencies, \`.csproj\`, Composer autoload, \`compile_commands.json\`); the
per-language rules are on the docs page Relations, flows, ports.

This is a built-in check, NOT an aspect. It has no \`content.md\` or \`check.mjs\`,
it is not attached through any of the seven aspect channels, and \`status:\`
(draft/advisory/enforced) does not apply — it is ALWAYS an error, and on a
project that names no reference branch (the default) it blocks \`yg check\`
unconditionally, exactly like the architecture and mapping validators. ONE
setting changes where it blocks, and only there: when progressive mode is on
(the project sets \`progressive.reference\`), a refusal the current change did not
reach is listed as a warning instead, and \`yg check --full\` blocks on it again.
The check itself is untouched by that — still not an aspect, still status-free,
still not waivable, and still blocking the moment a change reaches the code
carrying it. It is also NOT
\`yg-suppress\`-able (suppress waives aspects; this is not one). It is NOT stored in
the lock, and its verdict is never cached: resolve and verify run live on every
\`yg check\`, so it is never stale — a keyless \`yg check\` catches an undeclared
dependency at zero LLM cost. (Only the per-file parse facts are cached, in
\`.yggdrasil/.ast-cache/\`, keyed by the file's bytes, the grammar and the
extractor, so a file is re-parsed whenever any of those changes.) A lock file
that does not load withholds none of its findings.

Three design properties keep false positives out — it stays silent rather than guess:

- **One-directional.** A detected code dependency MUST be declared as a relation.
  The reverse does NOT hold: a declared relation needs no static code backing.
  Reflection, dependency injection, HTTP calls, and event (\`emits\`/\`listens\`)
  edges are legitimately declared without any resolvable call in the source, and
  the check never flags a relation that has no matching code.
- **Mapped-target-only, unambiguous-only.** The check fires only when the
  depended-on file is MAPPED to a known node. A dependency on an UNMAPPED file is
  a coverage matter (handled by \`unmapped-files\` / \`uncovered-advisory\`), never a
  relation error. And it resolves only edges it can pin to exactly one target node
  — anything dynamic, reflective, external, or not-uniquely-resolvable is silent.
  Intra-node dependencies and dependencies between a node and its own ancestor or
  descendant are exempt (they are not cross-node edges). There is no waiver: a
  finding is fixed by declaring the relation or removing the dependency, and a
  finding that names a dependency the code does not have is a resolver bug to
  report, not something to suppress.

Two ways to clear a refusal:

1. **Declare the relation** in the depending node's \`yg-node.yaml\`, choosing a
   STRUCTURAL relation type (\`calls\`, \`uses\`, \`extends\`, \`implements\`) the
   architecture allows between the two node types. An event relation (\`emits\` /
   \`listens\`) never counts: it describes a message, not an import. The relation
   may target the depended-on node OR any of its ancestors — a relation to a
   parent node sanctions dependencies on the parent and all of its descendants.
2. **Remove the dependency** if the code should not depend on the other node.

Related codes, all blocking: \`relation-broken\` (a relation's target node does
not exist), \`relation-target-forbidden\` (the architecture does not allow that
relation type to that target's type), \`relation-target-type-unknown\` (a
type's relation allow-list names a type that does not exist),
\`type-relation-forbidden\` (the same allow-list applied to an import between
two type-covered or classified files, under \`coverage.type_level\`),
\`relation-parse-failed\` (a mapped file could not be parsed, so the check
fails closed) and \`event-unpaired\`; \`high-fan-out\` is a warning. Their rows
are in \`yg knowledge read cli-reference\`.

If NO structural relation type is allowed between the two node types, that is a dead end you
cannot resolve at the node level — it is an architecture decision. Either change a
node's type so an allowed relation exists, or extend the allowed relations in
\`yg-architecture.yaml\` (requires the user's confirmation — never silent).

Declaring the relation satisfies the conformance check; what it carries across
the boundary is decided by ports, not by the declaration.
${RELATION_CARRIES_PORT_ASPECTS} If the dependency also needs to carry a critical
aspect across the boundary, put it on the target's \`default\` port, or publish a
named port carrying it and name that port in the relation's \`portNames\` (see
below).

## Structural relations must form a DAG

The four STRUCTURAL relation types (\`calls\`, \`uses\`, \`extends\`,
\`implements\`) must form a directed acyclic graph. A separate always-blocking
validator rejects any cycle among them with a \`structural-cycle\` error — a node
declaring a structural relation to itself counts as a cycle too. Like
\`relation-undeclared-dependency\` it is a built-in check, not an aspect: no
\`status:\` applies, and it is not \`yg-suppress\`-able.

So when the conformance check demands a relation and the reverse relation already
exists, declaring the missing direction is NOT the fix — it trades one blocking
error for another. Break the cycle instead: extract the shared piece into a third
node both sides depend on, or move the dependency so it flows one way. The EVENT
types (\`emits\` / \`listens\`) are outside this rule — they are the sanctioned way
to model a genuinely bidirectional exchange of messages, and they carry their own
pairing requirement instead. They never sanction an import: code that imports the
other side still needs a structural relation, so an event pair is no way around a
cycle.

## Ports — named entry points with aspects

A port is a named entry point on a node. Every node carries one implicitly —
\`default\` — whether or not it is declared: a relation that names no port
enters through \`default\`. A port that declares \`aspects\` says: "a relation
that enters through this port must also satisfy these aspects." In
\`yg-node.yaml\`:

\`\`\`yaml
name: PaymentsService
type: service
ports:                                  # map keyed by port name (NOT a list); optional
  charge:
    description: Capture a payment from the user
    aspects: [correlation-tracking, idempotency-key]
\`\`\`

\`default\` needs no \`description\` — it is the one port every node already
carries. A port's \`aspects\` is optional too: one that declares none loads as
a named entry that carries nothing, instead of refusing the node.

Every aspect id listed in a port's \`aspects\` must be defined under
\`aspects/\`. An undefined id is caught unconditionally by the
reference-integrity check (code \`aspect-undefined\`); when a relation
actually enters through the port, the missing aspect additionally surfaces
as \`port-missing-aspect\` (this holds for \`default\` too).

A relation names the port it enters through with \`portNames\`. In
\`yg-node.yaml\`, \`relations:\` is a flat list and each entry carries its own
\`type:\`:

\`\`\`yaml
name: OrdersHandler
type: command
relations:                             # flat list; type is a field on each entry
  - target: payments/service
    type: calls
    portNames: [charge]
\`\`\`

(The map-keyed-by-relation-type shape — \`relations: { calls: [...] }\` — is the
\`yg-architecture.yaml\` allowed-relations shape, not the node shape. The
deprecated alias field name still works — declaring both on the same
relation is refused.)

The named port's aspects become effective on the caller through channel 6.
The caller must now satisfy \`correlation-tracking\` and \`idempotency-key\`
for its own source files, in addition to its other aspects.

## Explicitly declaring \`ports.default\` hangs aspects on the implicit port

Declaring \`default\` under a node's \`ports:\` map is legal — it is how you hang
aspects on the implicit port, and those aspects bind every caller that names no
port. It is NOT needed to write \`consumes_port: default\` in a \`when:\`
predicate: reference validation exempts the reserved name, so that clause is
accepted whether or not any node declares the port. \`yg check\` raises nothing
for the declaration itself.

## A relation with no named port enters through \`default\`

Naming no port at all is not a gap — it is the normal path. \`portNames: []\`
(an empty list) is refused instead: an empty list would read as "name nothing",
and the parser will not silently reinterpret that as "enter through
\`default\`" — omit the field entirely for that, or name at least one real port.
The refusal happens in the NODE PARSER, so it surfaces as
\`code: yaml-invalid\`, not as a port-contract code, and the node fails to load;
the string \`port-names-empty\` appears only inside that error's message, and
filtering or suppressing on it matches nothing.

A relation that names nothing normalizes to \`portNames: [default]\`.
\`default\` carries whatever the owner put on it — nothing, unless declared —
so a caller is free to stay outside a named port's aspects simply by not
naming that port; \`yg check\` never forces a declaration. A node that needs
an aspect to hold on EVERY caller, regardless of what they name, gets that
only by putting the aspect on its own \`ports.default\`, and, if it has other
named ports too, repeating the aspect on each of them — a relation that
names a specific port enters ONLY through that port, not through \`default\`
as well.

## Why ports exist — the boundary channel 2 cannot cross

A critical aspect attached to a parent node propagates to all children via
channel 2 (ancestor). But it does NOT cross relation boundaries: a helper
node living outside the audit-logging parent but invoked from inside it
escapes the audit-logging aspect.

A port restores the boundary — but only for a relation that actually names
it:

1. Publish a port on the owner node carrying the critical aspect (\`default\`
   or a named one).
2. The caller names it: \`portNames: [<port-name>]\` on its inbound relation
   (or nothing, to enter through \`default\`).
3. The caller inherits the port's aspects (channel 6 propagation).

## Naming a port the target does not have

If a relation's \`portNames\` names a port that the target does not publish —
\`default\` excepted, since it always exists — \`yg check\` emits a blocking
error (code \`port-undefined\`). This holds the same way whether the target
declares other ports and simply lacks this one, or declares no ports at
all: either way there is no contract to check the named port against.
Resolve it by fixing the port name, or by adding the missing port to the
target node.

## When to use ports

Use a named port when:
- The target node enforces an aspect that some but not all callers MUST
  also satisfy. \`default\` binds every caller that names no port, so a named
  port is what lets you scope the requirement to only the ones that opt in.
- A security or compliance aspect must extend across files via the call
  chain, and only a subset of callers carry it.

Don't add one for ordinary internal calls, and don't add one just to make
an aspect reach every caller — put the aspect on \`default\` instead; no
declaration is needed on either side.

## yg context surfaces port-derived aspects

\`yg context --node <path>\` shows effective aspects per channel. Channel 6
entries are labeled with the source port and target node, making port
contracts visible at the consumer side.

## Aspect status in port aspects

Port aspects (channel 6) may declare \`status:\` to set their status.
A consumer inheriting a draft port aspect is not subject to enforcement
for that aspect. Advisory and enforced port aspects propagate enforcement
level along with the aspect via the channel 6 path. See:
\`yg knowledge read aspect-status\`.
`;
