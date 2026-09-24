---
id: kotlin-same-package-cross-node-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Packages and imports (same-package names need no import); research KT-05 (m28)"
---

## Rule

Two files in the same package may use each other's names without an import. When those files belong to different nodes the dependency is real, but the extractor is import-only: a bare simple name would have to be resolved through the precedence explicit import → same package → star import → default imports, and a same-named stdlib or default-imported symbol would make any guess a false edge. The use stays silent by design; the tolerated gap is recall, never precision.

## Files

```kotlin path=src/a/Order.kt
package com.acme.orders
class Order
```

```kotlin path=src/b/Refund.kt
package com.acme.orders
class Refund(val order: Order)
```

## Expect

- silence      # same-package use without an import → no edge (import-only extractor)

## Why

Resolving bare names needs the full Kotlin scope chain, including default imports a source-only tool cannot see.
