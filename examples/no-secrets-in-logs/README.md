# no-secrets-in-logs

**Scenario:** a fintech payments API that logs charge and refund activity — and must never write a raw secret or cardholder field to those logs.

## What this demonstrates

A **deterministic aspect** (`no-secret-in-logs`): a local `check.mjs` that scans every logging call and refuses the node if a log statement references a forbidden secret/PII identifier — `password`, `apiKey`, `secret`, `token`, `pan`, `cardNumber`, `cvv`, or `ssn`. This is a real PCI-DSS concern: retained log lines are in audit scope, so credentials and cardholder data must never reach them.

The check runs **keyless and free** — no API key, no LLM. Its verdict is cached in the gitignored `.yggdrasil/.yg-lock.deterministic.json`, filled for free by `yg check --approve --only-deterministic`. On a fresh clone, that verdict does not exist yet, so plain `yg check` reports the pair as *unverified* (exit 1) until the free fill runs once.

The realistic source logs only redacted values: a masked PAN (`maskedPan`) and generated ids (`chargeId`, `refundId`). The raw card fields stay out of every log call.

## Reproduce GREEN from a clean clone

Run everything with this directory as the working directory. `yg` is invoked here through the repo's local build.

```bash
cd examples/no-secrets-in-logs

# 1. Fresh clone: the deterministic verdict is not cached yet, so this is red
#    (the logging-rule pairs are "unverified"). Exit 1.
node ../../source/cli/dist/bin.js check

# 2. Fill the deterministic verdict — free, keyless, local. Writes only the
#    gitignored cache.
node ../../source/cli/dist/bin.js check --approve --only-deterministic

# 3. Now green. Plain check just re-hashes the cached verdict — still no key,
#    no LLM. Exit 0.
node ../../source/cli/dist/bin.js check
```

Expected final output:

```
yg check: PASS  2 nodes · 8/8 files · 1 aspects · 0 flows · 2 verified (2 deterministic, 0 LLM)
```

## The ONE edit that BREAKS the rule

In `src/charge.ts`, change the authorized-charge log line to leak the raw PAN:

```ts
// before (green):
logger.info("charge.authorized", { chargeId, maskedPan });

// after (breaks the rule):
logger.info(`charge.authorized ${request.card.pan}`, { chargeId, maskedPan });
```

Re-fill the deterministic verdict and check:

```bash
node ../../source/cli/dist/bin.js check --approve --only-deterministic
```

The check refuses the node with (line number is where the leaking log call sits):

```
Errors (1):

  enforced  1 pairs  1 nodes  aspect 'no-secret-in-logs'
            A deterministic check recorded these violations...
            - payments  Violations:
              src/charge.ts:53: Logging call references forbidden secret/PII field "pan". Log a redacted value (e.g. a masked PAN or an id) instead — raw cardholder data and credentials must never be written to logs (PCI-DSS).
```

Restore the original line and re-run steps 2–3 to return to green.

## Files

- `src/logger.ts` — tiny structured logger + `maskPan()` helper (a `library` node).
- `src/charge.ts`, `src/refund.ts` — charge / refund use cases that log redacted values only (a `service` node that `uses` the logging library).
- `.yggdrasil/aspects/no-secret-in-logs/` — the deterministic aspect (`yg-aspect.yaml` + `check.mjs`).
- `.yggdrasil/model/logging/`, `.yggdrasil/model/payments/` — the two graph nodes mapping the source.
- `.yggdrasil/yg-architecture.yaml`, `.yggdrasil/yg-config.yaml` — node types and (keyless) project config.
