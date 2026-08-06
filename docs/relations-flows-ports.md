---
title: Relations, flows & ports
---

Your components depend on each other. A handler calls a service; a service uses a logger. Sometimes a rule has to follow that dependency across a component boundary — the called code must obey a constraint the caller relies on. And sometimes a rule belongs to a whole business process, not a single component.

This page covers the three tools for those cases: **relations** (typed dependencies), **ports** (carry a rule across a boundary), and **flows** (a rule that spans a process). For the components themselves see [Nodes](/nodes); for the rules see [Aspects](/aspects).

---

## Relations

A relation keeps your dependencies inside the shape you designed. You declare what each component is allowed to depend on, and the graph holds every component to it. That declaration is a relation: a dependency from one node to another, written in the depending node's `yg-node.yaml`:

```yaml
# orders/order-service/yg-node.yaml
relations:
  - target: payments/payment-service
    type: calls
  - target: shared/logger
    type: uses
```

There are six relation types, in two families:

- **Structural** — `calls`, `uses`, `extends`, `implements`
- **Event-based** — `emits`, `listens`

The architecture file constrains which types may target which. Each node type either leaves a relation type unconstrained (the default — it may target any type) or lists the target node types it may reach; `yg check` rejects a relation whose target is not in a declared list. You can also lock a type down: `default: deny` forbids every relation type the node does not explicitly list (a sink), an empty list (`uses: []`) forbids a single relation type, and the wildcard (`uses: ['*']`) opens one to any target. An omitted `default` means allow, so this is fully backward-compatible. So if you decide a `service` may only `call` other services and `use` libraries, the graph holds every service to that.

Event relations come in pairs. If A `emits` to B, then B must declare a `listens` from A. `yg check` enforces the pairing with a blocking `event-unpaired` error. The pairing is matched by node path only — the optional `event_name` on the relation is documentation and is never compared.

Relations earn their keep two ways: `yg impact` uses them to compute the blast radius of a change, and the architecture allow-list keeps dependencies inside the shape you designed.

---

## Declared relations must match real dependencies

The graph's relations only help if they match reality. Yggdrasil keeps them honest with one built-in check.

On every `yg check`, it parses your actual source — TypeScript/JavaScript/TSX, Python, Go, Java, PHP, Kotlin, Rust, C, C++, C#, and Ruby — and finds where one component depends on another component's code. If that dependency is not declared as a relation, it **refuses** the component. The issue code is `relation-undeclared-dependency`.

The benefit is a map you can trust. Blast-radius analysis and the architecture allow-list mean nothing if the code quietly depends on things the graph never mentions. This check closes that gap.

Two properties keep it free of false alarms:

- **One-directional.** A real code dependency must be declared. The reverse is not required: a declared relation needs no code behind it. Dependencies over HTTP, dependency injection, reflection, and events are legitimately declared without any resolvable call in the source, and the check never complains about a relation with no matching code.
- **Mapped-target-only and unambiguous-only.** It fires only when the depended-on file is mapped to a known node — a dependency on an unmapped file is a coverage matter, not a relation error. And it resolves only dependencies it can pin to exactly one target. Anything dynamic, reflective, external, or not uniquely resolvable is left alone.
- **Hierarchy is exempt.** A dependency inside one component, or between a component and its own ancestor or descendant, needs no relation — those are not edges between two distinct components, so the check skips them.

This is not an aspect. It has no rule file, it is not attached to your nodes, and the draft/advisory/enforced levels do not apply — it is **always an error** and always blocks `yg check`, like the architecture and mapping validators. It cannot be suppressed.

There are two ways to clear a refusal:

1. **Declare the relation** in the component's `yg-node.yaml`, with a type the architecture allows between the two node types. A relation declared to a *parent* node also sanctions dependencies on any of its descendants, so you can point one relation at a subtree's root instead of at each child.
2. **Remove the dependency** if the code should not depend on the other component.

If no relation type is allowed between the two node types, that is an architecture decision. Your agent surfaces it for your confirmation — you either change a node's type so an allowed relation exists, or extend the allowed relations in `yg-architecture.yaml`.

One caveat on declaring the relation: the four structural relation types (`calls`, `uses`, `extends`, `implements`) must form a DAG. If two components depend on each other, declaring both directions creates a cycle, which a separate always-blocking validator rejects with a `structural-cycle` error (a component relating to itself counts too). Break the cycle — extract the shared piece into a third component both depend on — rather than declaring a mutual dependency.

It also never passes over code it could not read. If a language's parser cannot be loaded, every file in that language would contribute zero detected dependencies — which would look exactly like "this file depends on nothing". Rather than go green over unanalyzed code, the check fails closed with a blocking `relation-parse-failed` naming the language and an affected file.

One detail worth knowing: this check runs on **every** `yg check`, not only `yg check --approve`. Its result is never cached: the resolve-and-verify join runs live on every call, so it is always the current truth of your code against the graph, at zero LLM cost. (Parsing a file is served from a content-addressed cache when its bytes are unchanged, but the resolution and the verdict are always recomputed.) That is what lets a keyless CI `yg check` catch an undeclared dependency even though it makes no LLM calls. When adopting Yggdrasil on an existing codebase, the first run names every file, target, and the exact `relations:` stanza to add.

### The same gate, widened to type-covered files

Everything above governs edges between two **explicit nodes**, using each node's own declared `relations:` list. With [`coverage.type_level`](/configuration#coverage-config) on, a second, additive gate runs alongside it: every statically-resolved import whose endpoints are both *classified* — an explicit node, a type-covered file, or one of each — is checked against the architecture's relation allow-list for the two node **types** involved, issue code `type-relation-forbidden`. It exists because a type-covered file has no `yg-node.yaml` of its own to declare a relation in, so the ordinary check above has nothing to attach to on that side of the edge. An edge into an ambiguous or unmatched file is never gated — this check can only see edges whose target already resolved to a type.

Like the built-in relation-conformance check, this is not an aspect (no status, no `yg-suppress`) and it is never cached — it runs live, at zero LLM cost, on every `yg check`. Clearing a refusal has three exits instead of two, cheapest first: allow the type pair in `yg-architecture.yaml` (clears every edge between those two types at once), give the target file an explicit node with a curated relation (restores ordinary declared-edge semantics for just that file), or remove the dependency.

**Be honest with yourself about how much this gate is actually doing.** A node type with no `relations:` table at all has an absent default, and an absent default means *allow* — every relation type, to every target — so the gate is vacuous for that type's edges until you write one. A project with no relation tables anywhere gets zero protection from turning `type_level` on; the gate exists, but nothing is declared for it to enforce against. The free way to see how much a real table would catch: add one deny-default table (`relations: { default: deny, uses: [library] }`, say), run plain `yg check`, read what it names, and decide whether to keep it or revert — no `--approve`, no cost, no commitment. A mature set of deny-default tables converts every silent explicit-to-uncovered-type edge into a blocking error the moment you turn the flag on; an empty or allow-everything architecture converts none of them.

---

## Ports

A relation connects two nodes. It does **not** carry the target's rules to the caller. Most of the time that is correct — calling a service does not make the service's internal rules your problem.

But sometimes it should. When the target enforces a rule that consumers must also satisfy — a correlation ID that has to flow through the call, an idempotency key, an audit trail — you model it as a **port**.

A port is a named entry point on a node with required aspects:

```yaml
# payments/payment-service/yg-node.yaml
ports:
  charge:
    description: "Charge a payment method"
    aspects: [correlation-tracking]
```

A consumer opts into the port through its relation, with `consumes`:

```yaml
# orders/order-service/yg-node.yaml
relations:
  - target: payments/payment-service
    type: calls
    consumes: [charge]
```

Now `orders/order-service` must satisfy `correlation-tracking` for its own code, because it consumes the `charge` port. The rule has crossed the boundary.

**Why this exists.** A rule attached to a parent node reaches all of its children automatically. But it does not cross a relation. A helper that lives outside the audited parent, yet gets called from inside it, would slip past the audit rule. Ports restore the boundary: the owner publishes the rule as a port, the caller declares `consumes`, and the rule reaches the caller's code along the call.

Four blocking errors keep the port contract honest, and none of them has an "accept the gap" option:

| Code | When it fires | Fix |
|---|---|---|
| `port-missing-consumes` | The target declares ports and the consumer's relation declares no `consumes`. | Declare which ports you consume, or remove the ports from the target. |
| `consumes-without-ports` | A relation declares `consumes` naming a target that declares no ports at all. | Drop the `consumes`, or add the named port to the target. |
| `port-undefined` | A relation's `consumes` names a port the target does not have. | Fix the port name, or add the missing port to the target. |
| `port-missing-aspect` | A consumed port lists a rule that is not defined under `aspects/`. | Define the rule, or remove it from the port. (An undefined id is caught as `aspect-undefined` whether or not the port is consumed; this code is the "and it is actually being consumed" case.) |

Each message names the relation, explains what would go unverified, and tells you what to add.

---

## Flows

A flow is a business process that spans several components — "customer places an order, payment is captured, inventory is reserved." It groups the participating nodes and attaches shared rules to all of them.

```yaml
# .yggdrasil/flows/checkout/yg-flow.yaml
name: Checkout
description: "Customer places order, payment is processed, inventory reserved"
nodes:
  - orders/order-service
  - payments/payment-service
  - inventory/inventory-service
aspects:
  - correlation-tracking
```

Every aspect on the flow applies to every participant. So `correlation-tracking` above is now a rule each of those three services must satisfy — one place to require it across a whole process, instead of repeating it on every node.

Declaring a parent node as a participant includes all of its descendants. List `orders` and every node under it joins the flow; add a new child later and it is already covered, no edit to the flow file.

A flow is not a call chain. It describes the *why* — the business process being served — while relations describe the *how*, what calls what. Both can exist between the same nodes at once. Use a flow when a real-world process spans multiple components and a shared rule applies across them; if you only need to apply a rule to a subset of participants, an aspect can carry a [`when` predicate](/conditional-aspects) per attach site.
