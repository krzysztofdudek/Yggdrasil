# Examples

Self-contained examples showing Yggdrasil in action. Each directory is a
standalone project with source code and a `.yggdrasil/` graph.

## Examples

### `passing/` — Clean graph

A small order API where all aspects are satisfied. Run `yg check` and see
it pass.

```bash
cd examples/passing
yg check    # PASS — everything clean
yg tree     # see the graph
```

### `failing/` — Deliberate violation

Same project, but the payment service is missing audit logging — a violation
of the `requires-audit` aspect. The reviewer is configured to use Claude Code
by default — run `yg init` to switch to a different provider.

```bash
cd examples/failing
yg check                     # FAIL — payments never approved
yg approve --node payments   # reviewer rejects: audit logging missing
```

Fix `src/payments.ts` by adding audit logging, then re-run `yg approve` to
see it pass.

## Project structure

Both examples model a simple e-commerce backend:

```
src/
  api.ts         — HTTP endpoint (no aspects, just coverage)
  payments.ts    — Payment processing (must emit audit events)

.yggdrasil/
  model/
    api/          — node mapping src/api.ts
    payments/     — node mapping src/payments.ts, aspect: requires-audit
  aspects/
    requires-audit/   — rule: every mutation must emit an audit event
```
