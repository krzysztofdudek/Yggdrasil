# type-level — a rule that applies before anyone writes a component

**Scenario:** a checkout backend with three ordinary step handlers, one
admin-only step, one data-access file, and three small shared helpers.

**Capability demonstrated:** a file that matches exactly one classifying
type is enforced by that type's per-file rules **with no component of its
own** — no `yg-node.yaml`, ever, for that file. Three of this project's
handlers are never mapped to anything, yet each is checked against a real
rule the moment it exists. This is the payoff: on a project that keeps
adding small, similar files (another handler, another step), the rule
applies from the first commit that adds one, not from whenever someone
gets around to writing that file a node. There is no window where a new
file ships unenforced because the graph has not caught up with it yet.

Two other files in this project need a component anyway, for two different
reasons the README walks through below — an ambiguous match, and a rule
serious enough to demand a name and a reviewable component rather than
silent automatic coverage.

This example is **keyless**: every rule here is a *deterministic* aspect (a
local `check.mjs`, no LLM, no API key). All three verdicts are filled for
free by `yg check --approve --only-deterministic`.

## What is in the graph

- **Four classifying types** in `.yggdrasil/yg-architecture.yaml`:
  - `handler` (`src/handlers/**/*.ts`) — carries `validates-input`: every
    handler must call `validate(...)` on its request body before acting on
    it.
  - `admin-handler` (`src/handlers/admin/**/*.ts`) — carries
    `validates-input` and `elevated-audit` (a role check). Its path sits
    *inside* `handler`'s path, so any file under `src/handlers/admin/`
    matches both types at once.
  - `repository` (`src/repositories/**/*.ts`) — carries
    `parameterized-queries`, and is the one type with `enforce: strict`:
    missing this type on a query file means missing the guarantee that
    every query is parameterized, so the architecture never lets a
    matching file stay unclassified in either direction.
  - `library` (`src/lib/**/*.ts`) — no aspects at all. Matching this type is
    enough to satisfy coverage; there is nothing yet worth enforcing on
    shared helpers, the same way a hand-written node can carry a mapping
    and no aspects (see `docs/nodes.md`'s minimal-node pattern — this is
    that same idea, at the type level, with zero YAML).
- **Three aspects**, all deterministic and `scope: { per: file }` — a
  whole-unit (`per: node`, the default) rule can never produce a verdict on
  a file with no owning node, so every rule here has to be file-scoped to
  reach the type-covered files at all.
- **Two explicit nodes** — the only `yg-node.yaml` files in the project:
  - `refund-handler` (`src/handlers/admin/refundOrder.ts`, type
    `admin-handler`) — its path matches *two* non-strict types at once
    (`handler` and `admin-handler`). Type-level coverage refuses to guess
    which rules apply, so this file needs a component that says which type
    it actually is. See "The ambiguous file" below.
  - `order-repository` (`src/repositories/orderRepository.ts`, type
    `repository`) — `repository` is `enforce: strict`, so a matching file
    always needs an explicit component, even though its rule would
    otherwise have applied automatically like `handler`'s does. See "The
    strict type" below.
- **Six type-covered files, no node at all** — the three ordinary handlers
  (`reviewCart.ts`, `capturePayment.ts`, `scheduleFulfillment.ts`) and the
  three library helpers (`validate.ts`, `auth.ts`, `db.ts`).

## Reproduce GREEN from a clean clone

Run everything with this example directory as the working directory:

```bash
cd examples/type-level

# 1. See the unfilled state — 2 nodes, 6 type-covered files, 6 pairs waiting:
node ../../source/cli/dist/bin.js check

# 2. Fill the deterministic verdicts for free (no API key, no LLM):
node ../../source/cli/dist/bin.js check --approve --only-deterministic

# 3. Verify — should print PASS and exit 0:
node ../../source/cli/dist/bin.js check
```

Step 1 fails on a fresh clone (exit 1) — six `unverified` pairs, three of
them on files with no node at all (`src/handlers/reviewCart.ts` and its two
siblings), proving the architecture does not pre-satisfy itself. Step 2
fills all six for free; step 3 reproduces:

```
yg check: PASS  2 nodes · 12/12 files (2 node-owned, 6 type-covered, 4 excluded) · 3 aspects · 0 flows · 6 verified (6 deterministic, 0 LLM)

Type coverage:
  'handler' — 3 files covered: src/handlers/capturePayment.ts, src/handlers/reviewCart.ts, src/handlers/scheduleFulfillment.ts
    Enforced: validates-input (3)
    inherited rules stop at 'handler' — it has no parent type to inherit from
  'library' — 3 files covered: src/lib/auth.ts, src/lib/db.ts, src/lib/validate.ts
    Enforced: (none)
    inherited rules stop at 'library' — it has no parent type to inherit from

3 files matched by a type have no rules that apply to them — they satisfy coverage with no enforcement:
  - src/lib/auth.ts
  - src/lib/db.ts
  - src/lib/validate.ts
```

`yg tree` shows the same shape from the graph side — two named components,
plus everything else folded into the type-level lattice:

```
$ node ../../source/cli/dist/bin.js tree

order-repository [repository] — Order data access — repository is enforce: strict, so this file needs an explicit component even though its rule would otherwise apply automatically
refund-handler [admin-handler] — Admin-only refund step — its path also matches the ordinary handler type, so it needs a component of its own to say which one it actually is

6 files are satisfied by the type-level lattice, no component of their own: 3 checked by at least one rule, 3 with nothing that applies.
```

And `yg context --file` on a file with no node at all still names the exact
rule in force and where to read it:

```
$ node ../../source/cli/dist/bin.js context --file src/handlers/reviewCart.ts

src/handlers/reviewCart.ts
  Owner: unmapped

  Matched type: handler
  inherited rules stop at 'handler' — it has no parent type to inherit from

  Must satisfy:

    validates-input [enforced] — Every handler must validate its request body before acting on it
      read: .yggdrasil/aspects/validates-input/check.mjs
  ...
```

## The value: a rule that reaches code nobody wrote a node for

Delete the `validate(...)` call from `src/handlers/capturePayment.ts` — a
file with **no `yg-node.yaml`, ever**, purely covered by matching the
`handler` type. Then re-fill and check:

```bash
node ../../source/cli/dist/bin.js check --approve --only-deterministic
node ../../source/cli/dist/bin.js check
```

The file is refused anyway:

```
Errors (1):

  enforced  1 pairs  1 files  aspect 'validates-input'
            A deterministic check recorded these violations. The result is cached — the same inputs reproduce the same verdict, so the check is not re-run.
            Fix: Fix the listed violations, then: yg check --approve
            - src/handlers/capturePayment.ts  Violations:
              src/handlers/capturePayment.ts:1: Handler does not validate its input: call validate(req.body, [...]) before acting on it.
```

Nobody had to write a node for `capturePayment.ts` first. The rule was
already live the moment the file matched `handler`'s path. Put the
`validate(req.body, ['cartId', 'amount']);` call back, re-run the two
commands above, and the project is green again.

## The ambiguous file: two types, one file, no automatic answer

`src/handlers/admin/refundOrder.ts` matches both `handler` and
`admin-handler` — the second type's path sits entirely inside the first
type's. Type-level coverage never guesses between two matching types, so
this file has an explicit node (`refund-handler`) declaring `type:
admin-handler`. Move that node's file out of the way and check again:

```bash
mv .yggdrasil/model/refund-handler/yg-node.yaml /tmp/refund-handler.yaml
node ../../source/cli/dist/bin.js check
```

```
Errors (1):

  ambiguous-node-type
            File 'src/handlers/admin/refundOrder.ts' matches 2 classifying types: admin-handler, handler.
            Why: Type-level coverage applies exactly one type's rules per file. Two matching types is a situation the machine refuses to guess — each type carries different rules.
            Fix: Two exits:
              1. Create an explicit node declaring the intended type (yg-node.yaml with type: <one of: admin-handler | handler>) — its pairs re-key under the owner.
              2. Narrow one of the overlapping when: predicates in yg-architecture.yaml so exactly one matches — existing verdicts revalidate free.
```

Restore the node and check again to confirm green:

```bash
mv /tmp/refund-handler.yaml .yggdrasil/model/refund-handler/yg-node.yaml
node ../../source/cli/dist/bin.js check
```

## The strict type: a rule serious enough to demand a name

`repository` is the one type with `enforce: strict` — every parameterized
query is a real security guarantee, so the architecture never lets a
matching file coast on automatic type coverage the way a handler does.
Move `order-repository`'s node out of the way the same way and check:

```bash
mv .yggdrasil/model/order-repository/yg-node.yaml /tmp/order-repository.yaml
node ../../source/cli/dist/bin.js check
```

```
Errors (1):

  type-strict-orphan
            File 'src/repositories/orderRepository.ts' satisfies when of type 'repository' (enforce: strict):
              ✓ path matches "src/repositories/**/*.ts"
            But file is not in any node's mapping.
            Why: Type 'repository' has enforce: strict — every file satisfying its when must belong to a mapping of a node of type 'repository'. Otherwise the file looks like a repository but bypasses repository-level enforcement.
            Fix: Create yg-node.yaml with type: repository and add 'src/repositories/orderRepository.ts' to its mapping.
```

Restore it the same way and re-run `check` to confirm green.

## Re-approve after any source edit

Every one of the demonstrations above ends by restoring the file it
changed and confirming a plain `yg check` is green again — that is the
state this directory is committed in. If you make a **lasting** edit to
anything under `src/`, re-approve before committing it:

```bash
cd examples/type-level
node ../../source/cli/dist/bin.js check --approve --only-deterministic
```

## The first flag-on example

Every other project under `examples/` runs with `coverage.type_level`
**off** (the default when the key is absent), because none of them needed
it to make their own point. This is the first one with it explicitly
`true`. If you are writing tooling that assumes every example has the same
graph shape (for instance, a script that regenerates every example's
transcripts), this project is a deliberate exception — it exists to be
the one example where the type-level lattice, not an explicit node, does
most of the enforcing.

## Do not commit the cache

The deterministic verdict cache (`.yggdrasil/.yg-lock.deterministic.json`)
and the AST cache (`.yggdrasil/.ast-cache/`) are rebuildable and
**gitignored** (see `.yggdrasil/.gitignore`). They are recreated for free
by `yg check --approve --only-deterministic`.
