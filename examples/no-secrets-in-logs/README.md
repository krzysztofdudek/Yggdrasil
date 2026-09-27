# no-secrets-in-logs

**Scenario:** a fintech payments API that logs charge and refund activity — and must never write a raw secret or cardholder field to those logs.

## What this demonstrates

A **script rule** (`no-secret-in-logs`): a local `check.mjs` that scans every logging call and refuses the node if a log statement references a forbidden secret/PII identifier — `password`, `apiKey`, `secret`, `token`, `pan`, `cardNumber`, `cvv`, or `ssn`. This is a real PCI-DSS concern: retained log lines are in audit scope, so credentials and cardholder data must never reach them.

The check runs **keyless and free** — no API key, no reviewer. Its verdict is cached in the gitignored `.yggdrasil/.yg-lock.deterministic.json`, filled for free by `yg check --approve --only-deterministic`. On a fresh clone, that verdict does not exist yet, so plain `yg check` reports the pair as *unverified* (exit 1) until the free fill runs once.

The realistic source logs only redacted values: a masked PAN (`maskedPan`) and generated ids (`chargeId`, `refundId`). The raw card fields stay out of every log call.

## Reproduce GREEN from a clean clone

Run everything with this directory as the working directory. `yg` is invoked here through the repo's local build.

```bash
cd examples/no-secrets-in-logs

# 1. Fresh clone: the script verdict is not cached yet, so this is red
#    (the logging-rule pairs are "unverified"). Exit 1.
node ../../source/cli/dist/bin.js check

# 2. Fill the script verdict — free, keyless, local. Writes only the
#    gitignored cache.
node ../../source/cli/dist/bin.js check --approve --only-deterministic

# 3. Now green. Plain check just re-hashes the cached verdict — still no key,
#    no reviewer. Exit 0.
node ../../source/cli/dist/bin.js check
```

Expected final output:

```
yg check: PASS  2 nodes · 3/3 files covered · 5 excluded · 2 pairs verified (script)
```

## The ONE edit that BREAKS the rule

In `src/charge.ts`, change the authorized-charge log line to leak the raw PAN:

```ts
// before (green):
logger.info("charge.authorized", { chargeId, maskedPan });

// after (breaks the rule):
logger.info(`charge.authorized ${request.card.pan}`, { chargeId, maskedPan });
```

Re-fill the script verdict and check:

```bash
node ../../source/cli/dist/bin.js check --approve --only-deterministic
```

The fill records the refusal and its report refuses the node, exit 1 (the line number is where the leaking log call sits; the two `fill` progress lines go to stderr):

```
fill  1 pair · 1 script (free) · 0 reviewer calls
fill  done in 0s — 0 passed · 1 refused · 0 failed · 0 reviewer calls
yg check: FAIL  1 error   2 nodes · 3/3 files covered · 5 excluded · 1 pair verified (script)

error[refused] no-secret-in-logs — 1 violation in payments
  at:   payments  src/charge.ts:53  Logging call references forbidden secret/PII field "pan". Log a redacted value (e.g. a masked PAN or an id) instead — raw cardholder data and credentials must never be written to logs (PCI-DSS).
  why:  A logging statement must never reference a raw secret or PII field (PCI-DSS).
  fix:  Change the code at these lines, then run yg check --approve --only-deterministic (free) to record the new verdict.

next: edit src/charge.ts:53
```

Restore the original line and re-run steps 2–3 to return to green.

## Files

- `src/logger.ts` — tiny structured logger + `maskPan()` helper (a `library` node).
- `src/charge.ts`, `src/refund.ts` — charge / refund use cases that log redacted values only (a `service` node that `uses` the logging library).
- `.yggdrasil/aspects/no-secret-in-logs/` — the script rule (`yg-aspect.yaml` + `check.mjs`).
- `.yggdrasil/model/logging/`, `.yggdrasil/model/payments/` — the two graph nodes mapping the source.
- `.yggdrasil/yg-architecture.yaml`, `.yggdrasil/yg-config.yaml` — node types and (keyless) project config.
