# checkout-flow — one rule on a business process, enforced on every step

**Scenario:** an e-commerce checkout process with three step handlers — review the
cart, capture payment, schedule fulfillment.

**Capability demonstrated:** a single rule attached to a **flow** (a business
process) propagates to **every participant** in that process. Here the rule is
"every checkout step must emit a telemetry event", and it is enforced on the cart,
the payment, and the fulfillment step alike — even though it is declared exactly
once, on the flow.

This example is **keyless**: the rule is a *script rule* (a local
`check.mjs`, no reviewer, no API key). Its verdict is filled for free by
`yg check --approve --only-deterministic`.

## What is in the graph

- **Three step nodes** — `cart` (`src/cart.ts`), `payment` (`src/payment.ts`),
  `fulfillment` (`src/fulfillment.ts`), each a checkout step handler.
- **One library node** — `telemetry` (`src/telemetry.ts`) exposing `track(...)`.
  Each step declares a `uses` relation to it (satisfying the built-in
  relation-conformance check, since each step imports `track`).
- **One flow** — `checkout` (`.yggdrasil/flows/checkout/yg-flow.yaml`) whose
  participants are the three step nodes, carrying the flow-level script
  rule **`emits-telemetry`**.
- **The rule** — `.yggdrasil/aspects/emits-telemetry/check.mjs` scans each step's
  source for a `track(` call. Present → pass; absent → refuse. Because the aspect
  sits on the flow, it reaches all three participants (channel 5).

## Reproduce GREEN from a clean clone

Run everything with this example directory as the working directory:

```bash
cd examples/checkout-flow

# 1. Fill the script verdicts for free (no API key, no reviewer):
node ../../source/cli/dist/bin.js check --approve --only-deterministic

# 2. Verify — should print PASS and exit 0:
node ../../source/cli/dist/bin.js check
```

Expected final output:

```
yg check: PASS  4 nodes · 4/4 files covered · 5 excluded · 3 pairs verified (script)
```

> On a fresh clone, step 1 is required: the script verdict lives in the
> gitignored `.yggdrasil/.yg-lock.deterministic.json`, so before the free fill a
> plain `yg check` reports the three `emits-telemetry` pairs as *unverified*
> (exit 1). The free fill turns them green.

You can also see the propagation directly:

```bash
node ../../source/cli/dist/bin.js flows          # Checkout — Participants: 3 nodes (cart, fulfillment, payment) · Aspects: emits-telemetry
node ../../source/cli/dist/bin.js impact --flow checkout   # Blast radius: 3 nodes
```

## The ONE edit that BREAKS the rule

Remove the telemetry call from a single step — for example, delete the
`track('payment.captured', { ... });` block in `src/payment.ts`. Then re-fill and
check:

```bash
node ../../source/cli/dist/bin.js check --approve --only-deterministic
node ../../source/cli/dist/bin.js check
```

**Only the `payment` participant is refused** (cart and fulfillment stay green),
proving the flow-level rule reaches every participant independently:

```
yg check: FAIL  1 error   4 nodes · 4/4 files covered · 5 excluded · 2 pairs verified (script)

error[refused] emits-telemetry — 1 violation in payment
  at:   payment  src/payment.ts:1  Checkout step does not emit a telemetry event: add a track(...) call (e.g. track('cart.viewed', { ... })) so this step appears in the funnel.
  why:  Every checkout step must emit a telemetry event via a track(...) call so the funnel can be reconstructed
  fix:  Change the code at these lines, then run yg check --approve --only-deterministic (free) to record the new verdict.

next: edit src/payment.ts:1
```

**Restore green:** put the `track('payment.captured', { ... });` call back in
`src/payment.ts`, then re-run the two commands under "Reproduce GREEN" above.

## Do not commit the cache

The script verdict cache (`.yggdrasil/.yg-lock.deterministic.json`) and
the AST cache (`.yggdrasil/.ast-cache/`) are rebuildable and **gitignored** (see
`.yggdrasil/.gitignore`). They are recreated for free by
`yg check --approve --only-deterministic`.
