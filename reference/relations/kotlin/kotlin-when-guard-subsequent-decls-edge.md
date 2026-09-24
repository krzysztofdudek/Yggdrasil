---
id: kotlin-when-guard-subsequent-decls-edge
language: kotlin
category: trap
expectation: edge
cites: "What's new in Kotlin 2.2.0 — Guard conditions in when expressions (Stable); research GF-1 + KT-01 (B1)"
---

## Rule

A `when` guard (`is String if s.isNotEmpty() ->`, Stable since Kotlin 2.2) is syntax the shipped tree-sitter-kotlin grammar does not know: it turns everything from the guarded function to the end of the file into one ERROR node, so every later declaration vanished from the symbol table. The extractor now recovers: it blanks the guard (`if <condition>` before the `->`, same length, so every position stays put) and re-parses; whatever still fails is re-parsed one top-level declaration at a time. The declarations after the guard are indexed again, so an import of one of them edges.

## Files

```kotlin path=src/pay/Payments.kt
package com.acme.pay
fun describe(x: Any) = when (x) {
    is String if x.isNotEmpty() -> "text"
    else -> "other"
}
class PaymentService
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.pay.PaymentService
class C
```

## Expect

- src/c/Use.kt:2 -> node:pay      # PaymentService is declared after the when-guard and is indexed again
