---
id: kotlin-jvmname-no-facade-key-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin docs — Packages and imports; Baeldung — JVM Platform Annotations (`@JvmName` facade); research Form C2/F8"
---

## Rule

`@file:JvmName("OrderUtils")` renames the JVM facade class for Java interop only — a bytecode artifact, NOT a Kotlin source symbol. The Kotlin FQN is unchanged: a top-level `fun place()` in `package com.acme.orders` keeps the key `com.acme.orders.place`, and a consumer's `import com.acme.orders.place` binds the declaring file through that key, never through the facade. The file does also declare its facade key (`com.acme.orders.OrderUtils`) in the JVM namespace it shares with Java, so a Java import of the facade binds (java-imports-kotlin-file-facade-edge); Kotlin source can never name a facade, so that key never changes what a Kotlin import resolves to (the runner's no-unexpected-edge check confirms there is no extra edge).

## Files

```kotlin path=src/o/Orders.kt
@file:JvmName("OrderUtils")
package com.acme.orders
class Order
fun place() {}
val DEFAULT = 0
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.orders.place
class C
```

## Expect

- src/c/Use.kt:2 -> node:o      # the Kotlin FQN `com.acme.orders.place` is unchanged by `@file:JvmName` (node o); no facade key invented

## Why

Binding a Kotlin reference through a facade class that never appears in Kotlin source would be wrong; the Kotlin FQN stays the only key a Kotlin import binds through, and the facade key serves Java consumers only.
