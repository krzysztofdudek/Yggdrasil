---
id: kotlin-multidollar-subsequent-decls-edge
language: kotlin
category: trap
expectation: edge
cites: "What's new in Kotlin 2.2.0 — Multi-dollar string interpolation (Stable); research GF-1 + KT-01 (B1)"
---

## Rule

A multi-dollar string (`$$"price: $$amount"`, `$$"""…"""`, Stable since Kotlin 2.2) makes the shipped grammar swallow the rest of the file into one ERROR node. The extractor blanks the leading dollar run of such a literal (same length) and re-parses, so the declarations after it, and their imports, are back.

## Files

```kotlin path=src/pay/Payments.kt
package com.acme.pay
val template = $$"price: $$amount"
class PaymentService
fun charge() {}
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.pay.PaymentService
import com.acme.pay.charge
class C
```

## Expect

- src/c/Use.kt:2 -> node:pay      # class declared after the multi-dollar string
- src/c/Use.kt:3 -> node:pay      # top-level function declared after it
