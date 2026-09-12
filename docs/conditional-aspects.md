# Conditional Aspects — the `when` filter

Sometimes an aspect attached through a channel applies to only *some* of the
nodes the channel delivers it to. Historically the only way to handle this
was textual — the aspect's `content.md` would say "applies only when X" and
the reviewer (LLM) would read the note and decide N/A per-node. That pays an
LLM call for every N/A node and risks a wrong decision.

The `when` predicate moves that decision into the graph. The CLI evaluates
it deterministically before the reviewer is invoked. If the predicate is
false for a node, the aspect is silently skipped on that node — no LLM
call, no reviewer uncertainty.

> **One grammar, three sites — same operators, two atom families.**
> Yggdrasil has a single predicate engine (`all_of` / `any_of` / `not`
> combinators). The site you write it at determines which atoms are legal —
> **node atoms** where the subject is a node, **file atoms** where the
> subject is a file:
>
> | Site | What it filters | Atom family |
> |---|---|---|
> | aspect `when:` (this page) | which **nodes** an aspect applies to | `node`, `relations`, `descendants` |
> | `yg-architecture.yaml` `node_types.*.when` | which **files** belong to a node type | `path`, `content` |
> | aspect `scope.files` | which **files** of a node are reviewed | `path`, `content` |
>
> Writing a file atom (`path`/`content`) in a `when:` is an error — the
> validator points you at `scope.files` instead, and vice versa. The grammar
> below is the node-applicability (`when:`) form. For the file forms, see
> `yg schemas read architecture`, `yg knowledge read working-with-architecture`,
> and the [scope section on the Aspects page](/aspects).

## When to reach for `when`

- The aspect is meaningful only when a relation, port, or property holds.
- Splitting the node type to "opt in" would be arbitrary or costly.
- The reviewer is currently deciding N/A via a textual clue in `content.md`.

## Grammar (at a glance)

```yaml
when:
  all_of: [<clause>, ...]    # AND — every clause must pass
  any_of: [<clause>, ...]    # OR — at least one passes
  not: <clause>              # negation
  # Or top-level atomics (implicit all_of):
  relations:
    <relation-type>:
      target_type: <type-id>
      target: <node-path>       # relative to model/
      consumes_port: <port>
  descendants:
    relations: { ... }
    type: <type-id>
    has_port: <port-name>
  node:
    type: <type-id>
    has_port: <port-name>
    has_mapping: true | false
    id: <node-path> | [<node-path>, ...]   # exact match against the node's path, relative to model/
```

`node.id` matches a node's path **exactly** — never a subtree. A list means
"any of these paths." Wrapped in `not:`, it turns into an exclusion: a rule
attached to a parent can exclude one named child without removing the child
from the parent, e.g. `when: { not: { node: { id: services/legacy } } }`.

`consumes_port` matches a relation's **normalized** port list, not only what it wrote
explicitly — a relation that named no port at all normalizes to `[default]`, so
`consumes_port: default` matches it too. Without that, the predicate would silently
miss every relation that reaches a node through the implicit `default` port.

Reference validation agrees with that rule: `when-unknown-port` exempts the
literal name `default`, in both shapes — bare, and `target`-qualified. The
implicit port every node carries is a real referent, so nothing has to be
declared to make the predicate legal: write `consumes_port: default` and it
passes. Declaring `ports: { default: … }` on a node is still legal — it is how
you hang aspects on the implicit entry, and `default` is the one port name whose
declaration needs no `description` — but it is not a prerequisite for this
idiom, and declaring it draws a non-blocking `port-default-reserved` warning of
its own.

`has_port` — under both `node:` and `descendants:` — is **not** normalized the
way `consumes_port` is. It is checked literally against the node's declared
`ports:` map, so `has_port: default` does **not** mean "every node": it matches
only nodes that explicitly write `ports: { default: … }`, which is usually almost
none. This is the opposite of `consumes_port: default`, which does match
relations that arrived through the implicit port. Do not reach for
`has_port: default` expecting a universal match.

Full grammar reference: `yg schemas read aspect`.

Beyond the structural shape, `yg check` also checks that *most* of the names a
predicate uses actually exist — a silent typo in a predicate would make it
quietly never match, which is the worst possible failure for something whose
whole job is to decide applicability. Three blocking errors cover it:
`when-unknown-type` (an unknown `node.type`, `descendants.type`, or
`target_type`), `when-unknown-node` (a relation `target` or a `node.id` — string
or any entry of a list — naming a component path that does not exist), and
`when-unknown-port` (an unknown `consumes_port` — the reserved `default` is
exempt, since every node carries that port). `has_port` is checked too, on both
`node:` and `descendants:` clauses, but only as a **warning**:
`when-unmatched-port` fires when the name is declared by no node anywhere in the
graph, which makes the clause false for every node. It never blocks, because two
legitimate shapes look identical to a typo — gating a rule off deliberately with
a port nothing declares, and naming a port that is planned but not declared yet.
So `node: { has_port: charrge }` still passes `yg check`; it just no longer
passes silently. A malformed predicate itself is
`when-predicate-invalid`; a malformed one on a rule or an `implies` edge is
`aspect-when-invalid`. Writing a file atom (`path`/`content`) where node atoms
belong is an error too, and the message points you at `scope.files` instead.

## Where to declare `when`

- **Globally on the aspect** (`yg-aspect.yaml`, top-level `when:`) — the aspect
  has this precondition *wherever* it is attached.
- **On any attach site** — the same channel-specific list entry (the *attach
  entry*) can become an object with `id` + `when`. This is the attach entry's
  own `when`, distinct from the `references:` feature (supporting files for an
  LLM reviewer prompt):

```yaml
aspects:
  - simple-aspect               # no filter
  - id: conditional-aspect      # attach entry with filter
    when:
      node: { has_port: charge }
```

Attach sites: `yg-node.yaml` aspects and ports, `yg-architecture.yaml`
`node_types.*.aspects`, `yg-flow.yaml` aspects, and `yg-aspect.yaml` `implies`.

Global and attach-site `when` combine via AND. An aspect is effective on a
node if at least one channel path passes both.

## End-to-end example

Aspect `error-handling/external-api-error-mapping`:

```yaml
name: ExternalApiErrorMapping
description: "Wrap and translate errors from external service clients"
when:
  any_of:
    - relations:
        calls: { target_type: service-client }
    - descendants:
        relations:
          calls: { target_type: service-client }
```

Architecture attaches the aspect on all commands:

```yaml
node_types:
  command:
    aspects: [error-handling/external-api-error-mapping]
```

Result:

- `orders/handler` has `calls: payments/service` where `payments/service`
  is of type `service-client`. Predicate passes → aspect effective →
  reviewer verifies error-mapping in source.
- `follow-ups/crud` has no call to any `service-client`. Predicate fails
  → aspect not effective → reviewer never invoked for it.

Later, a developer adds `calls: payments/service` to `follow-ups/crud`.
The predicate now passes, so a new pair is expected on the node; `yg check`
reports it as unverified and prompts `yg check --approve`.

## What `when` is *not*

- **Not for per-file exemptions.** That is what `yg-suppress` is for —
  inline, per-block, reviewer-honored waivers.
- **Not transitive across the relation graph.** A calling B calling C does
  not make C's relations visible on A. The predicate only inspects the
  node's own relations and its hierarchical descendants in `model/`.
- **Not a replacement for splitting an aspect.** If two aspects have
  meaningfully different rules, they should be separate aspects.
- **Not the same as `status`.** `when` decides whether an aspect *applies*
  to a node — `when=false` makes the aspect invisible (no reviewer, no
  cost, no display). `status` decides what happens *when it applies* —
  `draft` keeps the aspect dormant but still listed in context; `advisory`
  runs the reviewer but surfaces refusals as warnings; `enforced` blocks
  CI. Use `when` for applicability (this rule only applies to nodes that
  call an external service); use `status` for rule maturity. See
  [Aspect Status](/aspect-status).
- **Not part of the verdict hash.** `when`, `implies`, and ports are excluded
  from the pair's input hash by design — they decide *which* pairs are
  expected, applied live on every run, not what a recorded verdict answers
  for. So editing a `when` clause never invalidates a verdict already on
  file: it can only add pairs (fresh, `unverified`) or drop pairs (removed
  from the lock, no reviewer call) — a pair that stays expected keeps its
  exact hash. Contrast this with filtering the *same* condition inside a
  rule's own `content.md` (e.g. "only applies when status is X") — that
  changes the rule's bytes, which **is** hashed, so it invalidates every
  verdict for that rule everywhere it is attached. A status filter belongs
  in `when`, never in the rule's prose: in `when` it is free; in the rule
  text it costs a re-fill of every pair. See
  [The Lock](/the-lock#what-makes-a-verdict-valid).

## Visibility

`when=false` aspects are silently skipped. They do not appear in
`yg context --node` or `yg context --file`, do not count in
`yg impact --aspect <id>`, and never reach the reviewer. Applicability is
recomputed live on every run, so flipping a predicate from `false → true`
adds the aspect's pairs to the expected set (they appear as unverified until
`yg check --approve` fills them); flipping from `true → false` removes them
(garbage-collected from the lock — no reviewer call).
