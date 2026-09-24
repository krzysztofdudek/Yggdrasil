---
id: java-imports-kotlin-file-facade-edge
language: java
category: import
expectation: edge
cites: "Kotlin docs — Calling Kotlin from Java: package-level functions (`<File>Kt` facade, `@file:JvmName`); research KT-03 (M14)"
---

## Rule

Kotlin top-level functions and properties compile into a file facade class that Java sees: `<FileName>Kt` by default (`orderUtils.kt` → `OrderUtilsKt`), or the name given by `@file:JvmName("…")`. A Kotlin file with at least one top-level function or property therefore also declares its facade FQN in the JVM namespace, and a Java import (plain or static) of that facade binds to the Kotlin file. Kotlin source can never name a facade, so the facade key can only match a Java consumer.

## Files

```kotlin path=src/orders/orderUtils.kt
package com.acme.orders
fun place() {}
```

```kotlin path=src/pricing/Pricing.kt
@file:JvmName("PriceMath")
package com.acme.pricing
val VAT = 23
```

```java path=src/app/Checkout.java
package com.acme.app;
import static com.acme.orders.OrderUtilsKt.place;
import com.acme.pricing.PriceMath;
class Checkout {}
```

## Expect

- src/app/Checkout.java:2 -> node:orders      # default `<File>Kt` facade of orderUtils.kt
- src/app/Checkout.java:3 -> node:pricing     # `@file:JvmName("PriceMath")` facade
