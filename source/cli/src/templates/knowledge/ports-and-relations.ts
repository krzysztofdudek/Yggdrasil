export const summary = 'Six relation types, paired events, ports propagate aspects via channel 6, defense against cross-file evasion, missing-contract errors, built-in relation-conformance check';

export const content = `# Ports and relations

Relations express typed dependencies between nodes. Ports propagate aspects
across those dependencies — that is channel 6 of the seven aspect channels.

Mental model: bare relations connect nodes but do NOT carry aspects across
the boundary. Ports do. When a critical aspect must hold on both sides of
a call, model it with a port.

## Relation types

Six types split into two families:

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
every mapped source file (TypeScript/JS/TSX, Python, Go, Java, PHP, Kotlin, Rust,
C, C++, C#, Ruby), finds each statically-resolvable dependency on ANOTHER node's
code, and refuses a node that depends on a node it does not declare a relation to.
The issue code is \`relation-undeclared-dependency\`.

This is a built-in check, NOT an aspect. It has no \`content.md\` or \`check.mjs\`,
it is not attached through any of the seven aspect channels, and \`status:\`
(draft/advisory/enforced) does not apply — it is ALWAYS an error and blocks
\`yg check\`, exactly like the architecture and mapping validators. It is also NOT
\`yg-suppress\`-able (suppress waives aspects; this is not one). It is NOT stored in
the lock: it is recomputed live on every \`yg check\` (parse, resolve, verify, from
scratch), so it is never cached and never stale — a keyless \`yg check\` catches an
undeclared dependency at zero LLM cost.

Two design properties make it false-positive-free:

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
  descendant are exempt (they are not cross-node edges). The result is zero false
  positives by design — there is no waiver because none is needed.

Two ways to clear a refusal:

1. **Declare the relation** in the depending node's \`yg-node.yaml\`, choosing a
   relation type the architecture allows between the two node types. The relation
   may target the depended-on node OR any of its ancestors — a relation to a
   parent node sanctions dependencies on the parent and all of its descendants.
2. **Remove the dependency** if the code should not depend on the other node.

If NO relation type is allowed between the two node types, that is a dead end you
cannot resolve at the node level — it is an architecture decision. Either change a
node's type so an allowed relation exists, or extend the allowed relations in
\`yg-architecture.yaml\` (requires the user's confirmation — never silent).

A declared relation here is a bare relation: it satisfies the conformance check
but does NOT propagate the target's aspects. If the dependency also needs to
carry a critical aspect across the boundary, model a port and \`consumes\` it (see
below) in addition to declaring the relation.

## Ports — named entry points with aspects

A port on a node says: "consumers of this endpoint must satisfy these
aspects." In \`yg-node.yaml\`:

\`\`\`yaml
name: PaymentsService
type: service
ports:                                  # map keyed by port name (NOT a list)
  charge:
    description: Capture a payment from the user
    aspects: [correlation-tracking, idempotency-key]
\`\`\`

Every aspect id listed in a port's \`aspects\` must be defined under
\`aspects/\`. An undefined id is caught unconditionally by the
reference-integrity check (code \`aspect-undefined\`); when the port is
actually consumed, the missing aspect additionally surfaces as
\`port-missing-aspect\`.

A consumer references the port via the relation's \`consumes\`. In
\`yg-node.yaml\`, \`relations:\` is a flat list and each entry carries its own
\`type:\`:

\`\`\`yaml
name: OrdersHandler
type: command
relations:                             # flat list; type is a field on each entry
  - target: payments/service
    type: calls
    consumes: [charge]
\`\`\`

(The map-keyed-by-relation-type shape — \`relations: { calls: [...] }\` — is the
\`yg-architecture.yaml\` allowed-relations shape, not the node shape.)

The consumed port's aspects become effective on the consumer through
channel 6. The consumer must now satisfy \`correlation-tracking\` and
\`idempotency-key\` for its own source files, in addition to its other
aspects.

## Why ports exist — defending against cross-file evasion

A critical aspect attached to a parent node propagates to all children via
channel 2 (ancestor). But it does NOT cross relation boundaries: a helper
node living outside the audit-logging parent but invoked from inside it
escapes the audit-logging aspect.

Ports restore the boundary:

1. Define a port on the owner node carrying the critical aspect.
2. The helper node declares \`consumes: [<port-name>]\` on its inbound
   relation.
3. The helper inherits the port's aspects (channel 6 propagation).

An attacker who routes calls through an intermediary without declaring
\`consumes\` will not inherit the port's aspects — but \`yg check\` fails with
a blocking error on the missing port contract, surfacing the gap.

## Missing port contracts

If a target node declares ports and the consumer's relation does NOT
declare \`consumes\`, \`yg check\` emits a blocking error (code
\`port-missing-consumes\`) that fails the architecture gate. Like every
diagnostic, it is rendered in the what/why/next form: it names the
relation, explains that the target's port-required aspects won't be
verified without a \`consumes\` declaration, and tells you to add
\`consumes: [<port-names>]\` to the relation.

There is no "accept the gap" mechanism. Resolve it one of two ways:
declare which port(s) you consume on the relation, or remove the ports
from the target node.

## Consuming a target with no ports

The inverse is also an error. If a relation declares \`consumes\` naming a
target that declares NO ports, \`yg check\` emits a blocking error (code
\`consumes-without-ports\`). Resolve it by removing the \`consumes\` from the
relation, or by adding the named port(s) to the target node.

A target that DOES have ports but whose \`consumes\` names a port that does not
exist on that target emits a blocking error (code \`port-undefined\`). Fix the
port name in \`consumes\`, or add the missing port to the target node.

## When to use ports

Use ports when:
- The target node enforces an aspect that consumers MUST also satisfy.
- The aspect must cross node boundaries (helper invoked from owner).
- A security or compliance aspect must extend across files via the call
  chain.

Don't use ports for ordinary internal calls — bare relations are
sufficient when the called-into node has no aspect that the caller must
propagate.

## yg context surfaces port-derived aspects

\`yg context --node <path>\` shows effective aspects per channel. Channel 6
entries are labeled with the source port and target node, making port
contracts visible at the consumer side.

## Aspect status in port aspects

Port aspects (channel 6) may declare \`status:\` to control enforcement level.
A consumer inheriting a draft port aspect is not subject to reviewer enforcement
for that aspect. Advisory and enforced port aspects propagate enforcement
level along with the aspect via the channel 6 path. See:
\`yg knowledge read aspect-status\`.
`;
