---
title: Nodes
---

A node is how you point a rule at the right code. It groups a set of source files into one component — a module, a service, a library — and gives that component a name in the graph. Rules attach to nodes, so the first step in enforcing anything is drawing the line around what counts as one component: that line is what lets you, your agent, and the reviewer all talk about the same piece of code.

You write nodes as small YAML files under `.yggdrasil/model/`. One file per component.

## A node file

Here is a complete node — a component called `OrderService`:

```yaml
# .yggdrasil/model/orders/order-service/yg-node.yaml
name: OrderService
type: service
description: "Manages order lifecycle: creation, validation, state transitions"

aspects:
  - requires-audit
  - rate-limiting

relations:
  - target: payments/payment-service
    type: calls

mapping:
  - src/orders/
  - src/orders.ts
```

The fields:

- **name** — display name, shown in CLI output.
- **type** — must match a type defined in the architecture file (see [Node types](#node-types-the-architecture-file)). The type decides what rules apply by default and what this component is allowed to connect to.
- **description** — one line on what the component does. It shows in CLI context output and helps your agent understand the component. It is not optional: a node, rule, or flow with no description is a blocking `description-missing` error.
- **aspects** — the rules this component must satisfy. Each name points to an aspect under `.yggdrasil/aspects/`. See [Aspects](/aspects).
- **relations** — the other components this one depends on. See [Relations, flows, ports](/relations-flows-ports).
- **mapping** — which source files this node owns.

## Mapping files

`mapping` is the link between the graph and your real code. Each entry is a directory or a file, relative to the repo root:

```yaml
mapping:
  - src/orders/         # directory — owns every file inside, recursively (minus files a child node claims)
  - src/orders.ts       # file — exact match
```

Entries also accept minimatch glob patterns: `*` matches within a single path segment, `**` matches across segments. So you can own a slice of a directory without listing files one by one:

```yaml
mapping:
  - src/db/*Repository.ts   # only *Repository.ts directly in src/db/
```

`src/db/*Repository.ts` matches `OrderRepository.ts` but not `Helper.ts` and not anything in a subdirectory. `src/**/*.ts` matches every `.ts` file anywhere under `src/`.

Each source file has exactly one owner node. That rule keeps verification unambiguous — there is always one component, and one set of rules, responsible for any given file. When a parent maps a directory and a child node maps a specific file inside it, the child wins: that file is carved out of the parent's set, so the two never conflict. Two nodes mapping the same file any *other* way is an `overlapping-mapping` error.

::: warning A gitignored file inside a mapping is a false green, so it blocks
A directory or glob mapping entry expands over git-tracked files and skips anything `.gitignore` excludes. So a file that is *both* tracked and matched by a `.gitignore` pattern would be counted as covered while never producing a review subject — an enforced rule would pass over it with no reviewer ever seeing it. Rather than allow that, `yg check` blocks with `mapped-file-gitignored` and tells you the three ways out: un-ignore the file, name it **directly** in the mapping (a direct file entry bypasses gitignore), or stop tracking it.

The mirror case blocks too: a mapping entry that names a file directly which is *not* tracked at all is `file-mapping-gitignored` — either the file belongs in the repository, or it does not belong in the mapping.
:::

## Nesting and inheritance

Nodes nest by directory. A node at `model/orders/handler/` is a child of `model/orders/`. Children inherit their parent's aspects: a rule attached to `orders` applies to `orders/handler` and every other node beneath it. Add a rule once at the top of a subtree and it covers the whole subtree.

## Coverage and minimal nodes

You do not have to enforce rules on a component to put it in the graph. When you adopt Yggdrasil on an existing codebase, most of your code is not under enforcement yet — and that is fine. Create a node with a mapping and no aspects:

```yaml
name: LegacyAuth
type: module
description: "Legacy auth — mapped for coverage, no rules yet"
mapping:
  - src/legacy/auth/
```

A node with no aspects produces no rule verdicts and records nothing in the lock. It satisfies the coverage requirement for free. (One built-in check still runs on any node that maps code: if its files import another node's code, that dependency has to be declared as a relation — see [Relations, flows, ports](/relations-flows-ports).) The point is to get all your code mapped cheaply, then add rules where they matter, one component at a time. When you are ready to enforce something here, add an aspect to the node.

The node's type still has to be one that classifies files — a type with a `when` predicate. A purely organizational type (no `when`) cannot map files at all; `yg check` rejects a mapping on such a type.

Coverage — which files must be mapped, and how strictly — is configured separately. See [Configuration](/configuration).

## Node types (the architecture file)

Every node declares a `type`, and every type is defined once in `.yggdrasil/yg-architecture.yaml`. Types are the vocabulary of your architecture. A type can:

- **classify files** — a `when` predicate says which source files belong to this type, so your agent can place new files correctly. It is also enforced forward: every file a node of this type maps must match the type's `when`, or `yg check` reports a `type-when-mismatch`.
- **set default rules** — list aspects every node of the type must satisfy, so you attach a cross-cutting rule once instead of on every node.
- **constrain structure** — `parents` limits where a node of this type may nest; `relations` limits which types it may depend on, and through which relation type.
- **opt into the log gate** — `log_required: true` makes a change to a node of this type record a short note on *why* before it is verified — your agent writes it with `yg log add`. See [the log gate](/the-lock#the-log-gate).
- **close the type-shopping gap** — `enforce: strict` makes the classification bite in *both* directions. See below.

A compact example:

```yaml
node_types:
  module:
    description: "Business logic unit with a clear domain responsibility"
    when:
      path: "src/**"                  # a module owns source files, so its type needs a when

  service:
    description: "Provides functionality to other components"
    aspects: [requires-audit]       # every service must satisfy this rule
    log_required: true              # service changes carry intent worth recording
    parents: [module]               # a service nests under a module
    relations:
      calls: [service, library]     # a service may call services and libraries
      uses: [library]
    when:
      path: "src/**/*.service.ts"   # files that make a node a "service"

  library:
    description: "Shared utility code with no domain knowledge"
    when:
      path: "src/shared/**"
```

A type with a `when` predicate classifies files. A type without `when` is organizational — usable as a parent in the hierarchy, but its nodes cannot map any files. The boolean combinators (`all_of` / `any_of` / `not`) are the same ones used for [conditional aspects](/conditional-aspects), but the atoms differ by site: a type's `when` classifies *files* and accepts only `path:` (a minimatch glob on the repo-relative path) and `content:` (a regular expression against the file's contents), whereas an aspect's `when` filters *nodes* and uses node atoms instead. Here, use `path` and `content`.

### `enforce: strict` — both directions

By default a type's `when` is checked **forward** only: every file a node of that type maps must match the predicate. Nothing stops the reverse — a file that matches `service`'s predicate can quietly live in a `library` node, or in no node at all, and never pick up the rules the `service` type carries. That is the type-shopping gap.

`enforce: strict` closes it by also checking **backward**: every file in the repository matching the type's `when` must belong to exactly one node *of that type*.

```yaml
node_types:
  service:
    description: "Provides functionality to other components"
    aspects: [requires-audit]
    enforce: strict                  # both directions
    when:
      path: "src/**/*.service.ts"
```

Reach for it on the types where missing the type means missing a rule that matters — security, audit, anything regulatory. Do not reach for it while a predicate is still broad: `enforce: strict` on `path: "**"` demands that every file in the repository sit in that one type's mappings. Run `yg impact --type <id>` before you flip the flag; it previews which files would come out as orphans or misplaced, so you fix the gaps first rather than turning the build red to find them.

Four errors are specific to strict types, and each blocks `yg check`:

| Code | What it means |
|---|---|
| `enforce-strict-without-when` | The type declares `enforce: strict` with no `when` — there is no predicate to enforce backward against. |
| `type-strict-orphan` | A file matches the predicate but belongs to no node at all. |
| `type-strict-misplaced` | A file matches the predicate but belongs to a node of a *different* type. |
| `strict-overlap-conflict` | A file matches the `when` of **two** strict types, so neither can own it unambiguously. Narrow one predicate. |

They are reported alongside any `unmapped-files` coverage error, not folded into it — the symptoms are distinct and so are the fixes.

The architecture file is the foundation of the graph, so changes to it ripple across every node of the affected type. Change it deliberately, and confirm the change before applying it.

## A note on prompt size

Keep nodes a sensible size, because a component's files all reach the LLM reviewer in one prompt. When the reviewer is an LLM, all of the component's subject files go to it together with the rule, reference files, and — when the aspect ships a `companion.mjs` hook — any companion files resolved for that unit. All of these count toward the `max_prompt_chars` ceiling a reviewer tier can set. If an assembled prompt would exceed it, `yg check` reports `prompt-too-large` instead of letting the oversized pair through. The usual fix is to split an oversized node into smaller ones, or narrow which files a rule reviews. Deterministic checks read files directly and have no prompt, so this never applies to them. See [Configuration](/configuration).
