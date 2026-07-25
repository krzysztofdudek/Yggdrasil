# Layered architecture — a ride-hailing backend in three layers

**Scenario:** a ride-hailing backend split into a web layer, a domain layer,
and a data layer. Requests flow **web → domain → data**, and the web layer
must never reach into persistence directly.

**Capability demonstrated:** the built-in **relation-conformance check** plus
**architecture layering**. Every `yg check` parses the mapped source, finds
each real code dependency between components, and refuses any dependency that
is not a declared, architecture-allowed relation. This runs **live** on plain
`yg check` — no reviewer, no API key, no lock file involved — so a layering
violation turns the build red the instant the offending `import` appears.

## The layers

```
src/
  web/rideHandler.ts    — handler   → calls domain
  domain/rideService.ts — service   → calls data
  data/rideRepository.ts— repository (pure sink)
```

`yg-architecture.yaml` defines the allow-list:

- `handler` may `calls` → `service` — and `default: deny` closes every other
  relation type, so a handler cannot reach `repository` by any means.
- `service` may `calls` → `repository`.
- `repository` depends on nothing.

Each node declares the matching relation in its `yg-node.yaml`. The code's
real imports (`rideHandler` → `rideService`, `rideService` → `rideRepository`)
line up exactly with the declared relations, so the graph is green.

## Reproduce GREEN from a clean clone

No API key and no lock fill are needed — the relation check is live and
deterministic.

```bash
cd examples/layered-architecture
yg check          # PASS — 3 nodes · 4/4 files · 0 aspects
```

Expected output:

```
yg check: PASS  3 nodes · 8/8 files · 0 aspects · 0 flows
```

## The one edit that BREAKS it

Make the web layer reach into persistence directly. In
`src/web/rideHandler.ts`, add a direct import of the data layer and use it:

```ts
import { bookRide, completeRide } from '../domain/rideService.js';
import { findRide } from '../data/rideRepository.js';   // ← forbidden cross-layer import

export function getRide(req: HttpRequest): HttpResponse {
  const { id } = req.params;
  const ride = findRide(id);                             // ← handler → repository
  if (!ride) {
    return { status: 404, body: { error: 'not found' } };
  }
  return { status: 200, body: ride };
}
```

Run `yg check` again and it refuses — live, with no key and no lock:

```
yg check: FAIL  3 nodes · 8/8 files · 0 aspects · 0 flows

Errors (1):

  relation-undeclared-dependency  1 pairs  1 nodes
            A dependency on another component must be a sanctioned, declared relation. Undeclared edges erode the architecture allow-list of who may depend on whom.
            Fix: Declare the missing relation(s) in .yggdrasil/model/web/yg-node.yaml (or remove the dependency if it is not legitimate):
            data: no relation type is allowed from handler to repository; either change a node's type or update the allowed relations in .yggdrasil/yg-architecture.yaml (requires confirming the architecture change).
            - web  src/web/rideHandler.ts:5 → data

Next: Fix relation-undeclared-dependency in web
```

The architecture forbids **any** relation from `handler` to `repository`, so
the only ways out are to remove the cross-layer dependency (route the read
through the domain layer instead) or to change the architecture. Undo the edit
to return to green.
