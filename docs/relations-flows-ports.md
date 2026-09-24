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

This is not an aspect. It has no rule file, it is not attached to your nodes, and the draft/advisory/enforced levels do not apply — it is **always an error**, and it cannot be suppressed. On a project that names no reference branch — the default — that error blocks `yg check` unconditionally, exactly like the architecture and mapping validators.

One project-level setting changes where it blocks, and only there. When [progressive mode](/progressive-mode) is on, this refusal is one of the findings a change can inherit: a refusal your change did not reach is listed as a warning instead of an error, and `yg check --full` blocks on it again. Nothing about the check itself moves — it is still not an aspect, still has no status, still cannot be suppressed, and it still blocks the moment your change reaches the code that carries it.

There are two ways to clear a refusal:

1. **Declare the relation** in the component's `yg-node.yaml`, with a type the architecture allows between the two node types. A relation declared to a *parent* node also sanctions dependencies on any of its descendants, so you can point one relation at a subtree's root instead of at each child.
2. **Remove the dependency** if the code should not depend on the other component.

If no relation type is allowed between the two node types, that is an architecture decision. Your agent surfaces it for your confirmation — you either change a node's type so an allowed relation exists, or extend the allowed relations in `yg-architecture.yaml`.

One caveat on declaring the relation: the four structural relation types (`calls`, `uses`, `extends`, `implements`) must form a DAG. If two components depend on each other, declaring both directions creates a cycle, which a separate always-blocking validator rejects with a `structural-cycle` error (a component relating to itself counts too). Break the cycle — extract the shared piece into a third component both depend on — rather than declaring a mutual dependency.

It also never passes over code it could not read. If a language's parser cannot be loaded, every file in that language would contribute zero detected dependencies — which would look exactly like "this file depends on nothing". Rather than go green over unanalyzed code, the check fails closed with a blocking `relation-parse-failed` naming the language and an affected file.

One detail worth knowing: this check runs on **every** `yg check`, not only `yg check --approve`. Its result is never cached: the resolve-and-verify join runs live on every call, so it is always the current truth of your code against the graph, at zero LLM cost. (Parsing a file is served from a content-addressed cache when its bytes are unchanged, but the resolution and the verdict are always recomputed.) That is what lets a keyless CI `yg check` catch an undeclared dependency even though it makes no LLM calls. When adopting Yggdrasil on an existing codebase, the first run names every file, target, and the exact `relations:` stanza to add.

### Java and Kotlin

Java imports resolve by the package = directory convention under the importing file's own source root first. When that finds nothing — the class lives in a sibling Maven or Gradle module, or a test under `src/test` imports production code under `src/main` — the import is looked up by its fully-qualified name across every mapped Java and Kotlin file, and it counts only when exactly one file declares that name. Java and Kotlin share that namespace: a Kotlin file importing a Java class and a Java file importing a Kotlin class, object or file facade (`OrderUtilsKt`, or the name given by `@file:JvmName`) are both detected. A star import (`import a.b.*` in either language) is a dependency only when every mapped file of that package belongs to one component; a package split across components stays silent.

The Kotlin parser Yggdrasil ships (`@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0, a fork last released in January 2025) predates Kotlin 2.2. It does not know when-guards (`is String if s.isNotEmpty() ->`), multi-dollar strings (`$$"…"`) or context parameters (`context(log: Logger)`), and on each of them it gives up on the rest of the file. The check recovers: it re-reads such a file with those constructs masked, then declaration by declaration, so the declarations after them still count. Two limits remain. A type written inside a `context(…)` clause is not detected. And where a declaration still cannot be read, an import into that file's package that could have meant it stays silent rather than risk pointing at the wrong component. The actively developed Kotlin grammar (fwcd/tree-sitter-kotlin) handles when-guards and multi-dollar strings but has no npm release and uses different node names, so moving to it is a separate change.

### The same gate, widened to type-covered files

Everything above governs edges between two **explicit nodes**, using each node's own declared `relations:` list. With [`coverage.type_level`](/configuration#coverage-config) on, a second, additive gate runs alongside it: every statically-resolved import whose endpoints are both *classified* — an explicit node, a type-covered file, or one of each — is checked against the architecture's relation allow-list for the two node **types** involved, issue code `type-relation-forbidden`. It exists because a type-covered file has no `yg-node.yaml` of its own to declare a relation in, so the ordinary check above has nothing to attach to on that side of the edge. An edge into an ambiguous or unmatched file is never gated — this check can only see edges whose target already resolved to a type.

Like the built-in relation-conformance check, this is not an aspect (no status, no `yg-suppress`) and it is never cached — it runs live, at zero LLM cost, on every `yg check`. It follows that check in the other respect too: it blocks unconditionally by default, and under [progressive mode](/progressive-mode) a refusal your change did not reach is listed as a warning, with `yg check --full` blocking on it again. Clearing a refusal has three exits instead of two, cheapest first: allow the type pair in `yg-architecture.yaml` (clears every edge between those two types at once), give the target file an explicit node with a curated relation (restores ordinary declared-edge semantics for just that file), or remove the dependency.

**Be honest with yourself about how much this gate is actually doing.** A node type with no `relations:` table at all has an absent default, and an absent default means *allow* — every relation type, to every target — so the gate is vacuous for that type's edges until you write one. A project with no relation tables anywhere gets zero protection from turning `type_level` on; the gate exists, but nothing is declared for it to enforce against. The free way to see how much a real table would catch: add one deny-default table (`relations: { default: deny, uses: [library] }`, say), run plain `yg check`, read what it names, and decide whether to keep it or revert — no `--approve`, no cost, no commitment. A mature set of deny-default tables converts every silent explicit-to-uncovered-type edge into a blocking error the moment you turn the flag on; an empty or allow-everything architecture converts none of them.

### Known grammar limits

Each language is parsed by a pinned tree-sitter grammar. The CLI's language registry records the version, the upstream commit and the sha256 of every grammar it ships, and the build refuses a grammar whose bytes differ from its pin. A construct a grammar does not know becomes an `ERROR` node in the tree. A rule that reads the AST (`ctx.parseAst`, a file's `.ast`) sees that `ERROR`. The relation check never adds an edge from inside one, but it can miss a declaration or an import that the error swallowed.

These gaps are known in the shipped grammars, checked on 2026-09-24:

| Language | Grammar shipped | Parses as `ERROR` or misparses | Upstream |
|---|---|---|---|
| Go | 0.25.0 | Go 1.27 generic methods (`func (r *T) M[X any]() …`), which also drop out of the file's declarations; Go 1.26 `new(expr)` (`new(42)`). Imports are unaffected. | No fix; no grammar change since 2025-09. |
| TypeScript / TSX | 0.23.2 with upstream PRs #357, #358, #364, #365 applied, regenerated against JavaScript 0.25 | `import defer * as m from "…"`; `static accessor x`; `export … from "…" with { … }` (also in JavaScript). `using` / `await using` declarations, `export type *`, `in`/`out` variance and `typeof import("…").X<T>` parse. | The PRs are open and unmerged; nothing handles the other three yet. |
| Java | 0.23.5 | Java 25 flexible constructor bodies (statements before `super(…)` / `this(…)`); `import module java.base;`. Both edges around them survive. | No grammar change since 2024-12. |
| Kotlin | 1.1.0 (`tree-sitter-grammars` fork) | Kotlin 2.2+ `when` guards (`is Int if x > 0 ->`), `context(…)` parameters and `$$"…"` strings turn the rest of the file into one `ERROR`. | The fork has been dormant since 2025-01; the fwcd grammar has the fixes but different node types and no npm release. |
| C# | 0.23.5 | C# 14 extension blocks (`extension(Widget w) { … }` parses as a constructor) and `a?.B = 1`. | Supported on master, which this release does not take yet: an extractor handles the extension block's old shape and must learn the new one first. |
| PHP | master 3fda2fb9 (after 0.24.2) | PHP 8.5 `clone($obj, [...])`. PHP 8.4 asymmetric visibility (`private(set)`) now parses, in constructor promotion too. | `clone` with arguments: open. |
| Python | 0.25.0 | PEP 696 type-parameter defaults (`def f[T = int]()`, `class A[T = str]`). | Also fails on master. |
| Ruby | master ad907a69 (after 0.23.1) | A Ruby 4.0 leading `\|\|` / `&&` continuation line after an assignment (`x = foo(1)` followed by a line that starts with `\|\| bar`) splits into two statements. | Open. Master's heredoc fix (a delimiter of 256+ characters crashed the parser) is included. |
| C | 0.24.2 | `#embed` inside an initializer; `_BitInt(N)`. | Open. |
| C++ | master c0092228 (after 0.23.4) | Static lambdas (`[] static () { … }`) and `if consteval` leave small `ERROR` nodes. Modules (`export module`, `import "x.hpp"`) and explicit object parameters (`this S& self`) parse. | Open. |
| JSON | 0.24.8 | An exponent with an explicit plus sign (`1e+5`). | Fixed on master (2026-08-17), not released. |
| TOML | 0.7.0 | TOML 1.1: multi-line inline tables, the `\e` escape, times without seconds (`07:32`). | No release supports TOML 1.1. |

When a grammar changes, every deterministic verdict that read a syntax tree of that language is re-judged on the next `yg check --approve` (free and keyless for deterministic rules), because each such verdict records which grammar and parser runtime built the trees it read.

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

A relation opts into the port by naming it in `portNames`:

```yaml
# orders/order-service/yg-node.yaml
relations:
  - target: payments/payment-service
    type: calls
    portNames: [charge]
```

(`consumes:` still works, as a deprecated alias for `portNames:`.)

Now `orders/order-service` must satisfy `correlation-tracking` for its own code, because its relation names the `charge` port. The rule has crossed the boundary.

**Why this exists.** A port is a named entry to a node. `default` is the name every node carries without declaring it, and it is the entry every relation uses unless the relation names another. A rule attached to a parent node reaches all of its children automatically, but it does not cross a relation: a helper that lives outside the audited parent, yet gets called from inside it, would slip past the audit rule. Ports restore the boundary — the owner publishes the rule on a port, and the rule reaches every relation that enters through that port. Aspects flow through whichever entry declares them, and only through the entry a relation actually names: a relation that names a specific port enters only through that port, not through `default` as well. You declare a port to hang a rule on it — never to force anyone to declare anything; a relation that names nothing is the ordinary path, not a gap.

Three blocking errors keep the port contract honest, and none of them has an "accept the gap" option:

| Code | When it fires | Fix |
|---|---|---|
| `port-names-empty` | A relation declares `portNames` (or its deprecated alias) as an empty list. Unlike the other two rows this is not a distinct issue code: an empty list fails node parsing, so `yg check` reports it as `yaml-invalid` (rule `invalid-node-yaml`) and the text `port-names-empty` appears only inside that error's message. Filtering `yg check --json` or writing a suppression on `port-names-empty` matches nothing. | Omit the field entirely to enter through `default`, or name at least one real port. |
| `port-undefined` | A relation names a port the target does not publish — including when the target publishes no ports at all. `default` never fires this: it always exists. | Fix the port name, or add the missing port to the target. |
| `port-missing-aspect` | A named port — `default` included — lists a rule that is not defined under `aspects/`. | Define the rule, or remove it from the port. (An undefined id is caught as `aspect-undefined` whether or not a relation names the port; this code is the "and a relation actually enters through it" case.) |

Each message names the relation, explains what would go unverified, and tells you what to add.

Declaring a port literally named `default` is how you hang aspects on the implicit entry every node already carries; those aspects then apply to every consumer that names no port. `yg check` raises nothing for the declaration itself.

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

`nodes:` may also be written as `participants:` — the parser accepts the two as full aliases, and its own error messages name both spellings, so a file using either key (or an error quoting the other one) is reading the same field.

Every aspect on the flow applies to every participant. So `correlation-tracking` above is now a rule each of those three services must satisfy — one place to require it across a whole process, instead of repeating it on every node.

Declaring a parent node as a participant includes all of its descendants. List `orders` and every node under it joins the flow; add a new child later and it is already covered, no edit to the flow file.

A flow is not a call chain. It describes the *why* — the business process being served — while relations describe the *how*, what calls what. Both can exist between the same nodes at once. Use a flow when a real-world process spans multiple components and a shared rule applies across them; if you only need to apply a rule to a subset of participants, an aspect can carry a [`when` predicate](/conditional-aspects) per attach site.
