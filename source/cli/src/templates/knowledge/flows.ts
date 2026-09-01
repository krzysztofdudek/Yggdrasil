export const summary = 'Flow = business process; participants + flow-level aspects; descendant inclusion; flow vs relation';

export const content = `# Flows

A flow is a business process — a sequence of steps toward a user-visible
goal. Flows group nodes that participate in the same process and attach
shared aspects to all participants.

## Flow vs relation — distinct concepts

| | Flow | Relation |
|---|---|---|
| Scope | Business process | Code dependency |
| Example | "User places an order" | "Handler calls service" |
| Granularity | Cross-node group | Pair of nodes |
| Effect | Aspects to all participants (channel 5) | Allowed by architecture |

A flow describes the WHY (what business process this serves). A relation
describes the HOW (what calls what). Both can exist simultaneously between
the same nodes.

## Flow file structure

\`flows/<name>/yg-flow.yaml\`:

\`\`\`yaml
name: order-processing
description: Customer places an order, payment is captured, fulfillment is notified
nodes:                  # alias: participants
  - orders            # parent — descendants auto-included
  - payments/charge
  - fulfillment/notify
aspects:
  - deterministic                 # bare string
  - id: correlation-tracking      # object form
    when: <predicate>             # optional — per-site applicability filter
\`\`\`

\`description\` is required — a flow without it blocks \`yg check\` (the
validator emits \`description-missing\`). \`nodes:\` may also be written as
\`participants:\` (alias); the two are interchangeable.

Flow-level aspects accept either a bare string or the object form
\`{ id, when }\`. The \`when\` predicate filters applicability per
participant — see \`yg knowledge read conditional-aspects\` for the grammar.

Schema: \`yg schemas read flow\`.

## Descendant inclusion

Declaring a parent node in \`nodes:\` automatically includes all its
descendants. Example: declaring \`orders\` covers \`orders/handler\`,
\`orders/repo\`, \`orders/validator\`, etc.

Consequence: to add a new child node to a flow, you don't edit
\`yg-flow.yaml\`. Just create the child under the parent — it is already in
the flow. To exclude a specific descendant, restructure the hierarchy or
narrow the participant list.

## Flow-level aspect propagation

Aspects listed in \`aspects:\` on a flow apply to every participant via
channel 5. Each participant must satisfy them in addition to its own,
ancestor, type, port, and implied aspects.

Adding a flow-level aspect cascades: it adds that aspect's pairs to every
participant. Before changing flow aspects:

\`\`\`bash
yg impact --flow <name>
\`\`\`

This lists every participating node — that is the re-verification cost.

## When to create a flow

Create a flow when:
- You see a sequence of steps toward a single business goal.
- The steps span multiple nodes.
- A shared rule applies across the participants (deterministic ordering,
  correlation IDs, idempotency, audit trail).

Do NOT create a flow for:
- Code call sequences — those are relations.
- Single-node workflows — use the node's own aspects.
- Vague "everything in this area" groupings — use a parent node instead.

## Listing and inspecting flows

\`\`\`bash
yg flows                          # list all flows with participants and aspects
yg impact --flow <name>           # all participating nodes (with descendants)
\`\`\`

A flow's pairs are filled like any other by \`yg check --approve\` — there is no
per-flow approve command, and no way to ask for one flow's pairs alone.

## Renaming or splitting nodes

When you rename or split a node, update any flow's \`nodes:\` list that
references the old name. \`yg check\` catches broken references, but fixing
proactively avoids a noisy check output and a confused next agent.

## Aspect status on flow aspects

Flow aspects (channel 5) may declare \`status:\` to control enforcement level
across all participants. A flow aspect in draft or advisory status applies to
every participating node without forcing CI to block. See:
\`yg knowledge read aspect-status\`.
`;
