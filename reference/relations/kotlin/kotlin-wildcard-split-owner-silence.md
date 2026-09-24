---
id: kotlin-wildcard-split-owner-silence
language: kotlin
category: import
expectation: silence
cites: "Kotlin spec — Packages and imports (star-import); JLS §7.5.2 parity; research m26"
---

## Rule

A star import whose package is declared by files of two or more nodes stays silent: the import never says which of the package's names the file uses, so any single edge would be a guess and one edge per owner would over-report. A star import of a package no graph file declares (a library) is silent as well.

## Files

```kotlin path=src/a/Order.kt
package com.acme.orders
class Order
```

```kotlin path=src/b/Refund.kt
package com.acme.orders
class Refund
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.orders.*
import kotlinx.coroutines.*
class C
```

## Expect

- silence      # com.acme.orders is split across nodes a and b → no edge; the library star import has no owner

## Why

Attributing a split package to one node is a guess; attributing it to both claims dependencies the file may not have.
