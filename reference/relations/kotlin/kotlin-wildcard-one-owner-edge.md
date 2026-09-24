---
id: kotlin-wildcard-one-owner-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (star-import names a package or a classifier scope); JLS §7.5.2 parity; research m26"
---

## Rule

A star import `import a.b.*` names a package. Like Java's type-import-on-demand, it resolves to the set of graph files that declare a top-level member of `a.b` (Kotlin or Java), collapsed by owner: one owning node → one edge to it; zero owners → silence; two or more owners → silence (see kotlin-wildcard-split-owner-silence). The star is never expanded into per-name edges. A star import of a classifier's scope (`import a.b.Colors.*`, enum entries or object members) binds the classifier's declaring file.

## Files

```kotlin path=src/o/Order.kt
package com.acme.orders
class Order
fun place() {}
```

```kotlin path=src/o/Line.kt
package com.acme.orders
enum class Status { OPEN, CLOSED }
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.orders.*
import com.acme.orders.Status.*
import kotlinx.coroutines.*
class C
```

## Expect

- src/c/Use.kt:2 -> node:o      # every file of com.acme.orders belongs to node o → one edge
- src/c/Use.kt:3 -> node:o      # star import of an enum's entries → the enum's file
