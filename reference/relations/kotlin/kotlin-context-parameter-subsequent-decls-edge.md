---
id: kotlin-context-parameter-subsequent-decls-edge
language: kotlin
category: trap
expectation: edge
cites: "What's new in Kotlin 2.4.0 — Stable context parameters; What's new in Kotlin 2.2.0 — context parameters preview; research Form E5, GF-1 + KT-01 (B1)"
---

## Rule

A context-parameter clause `context(repo: com.acme.data.OrderRepo)` (Stable in Kotlin 2.4) is unknown to the shipped grammar, and without recovery it erased every declaration from the clause to the end of the file. The extractor blanks the whole clause (same length) and re-parses: the declaration it decorates (`fun save`) and everything after it are indexed again. The type written INSIDE the clause stays invisible, because it was blanked with the clause: a tolerated recall gap of the grammar, never a false edge. The same type written in a position the grammar knows (a parameter, a property) edges as usual.

## Files

```kotlin path=src/data/OrderRepo.kt
package com.acme.data
class OrderRepo
```

```kotlin path=src/svc/Service.kt
package com.acme.svc
context(repo: com.acme.data.OrderRepo)
fun save() {}
class OrderService
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.svc.save
import com.acme.svc.OrderService
class C
```

## Expect

- src/c/Use.kt:2 -> node:svc      # the decorated function is indexed again
- src/c/Use.kt:3 -> node:svc      # so is the class after it; no svc -> data edge: the type inside the context clause is blanked with the clause, so no edge (tolerated grammar gap)
