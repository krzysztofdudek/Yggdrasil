---
id: kotlin-kmp-source-set-import-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin Multiplatform docs — Source sets (commonMain / jvmMain); research KT-05 (m28)"
---

## Rule

In a Kotlin Multiplatform module the platform source set (`jvmMain`) imports declarations of the shared source set (`commonMain`) by FQN. Kotlin resolves by the package header, not by the directory, so the import binds to the common file through the symbol table whatever the source-set layout. When the two source sets are mapped to different nodes, that is an edge.

## Files

```kotlin path=shared/src/commonMain/kotlin/common/Money.kt
package com.acme.money
data class Money(val cents: Long)
```

```kotlin path=shared/src/jvmMain/kotlin/jvm/JvmFormat.kt
package com.acme.money.jvm
import com.acme.money.Money
fun Money.format(): String = cents.toString()
```

## Expect

- shared/src/jvmMain/kotlin/jvm/JvmFormat.kt:2 -> node:common      # the platform source set imports the common declaration by FQN
