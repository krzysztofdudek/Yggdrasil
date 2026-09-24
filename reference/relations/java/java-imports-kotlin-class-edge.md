---
id: java-imports-kotlin-class-edge
language: java
category: import
expectation: edge
cites: "Kotlin docs — Calling Kotlin from Java; JLS SE25 §7.5.1; research KT-03 (M14)"
---

## Rule

Java and Kotlin compile into one JVM namespace, so a Java file imports a Kotlin class by its FQN exactly as it imports a Java class. No `.java` file exists at the package path, so the resolver falls back to the shared JVM symbol table, which holds the Kotlin declarations too. A Kotlin class (and a Kotlin `object`, whose members Java reaches through a static import of the object) binds like any other type.

## Files

```kotlin path=src/pay/Payments.kt
package com.acme.pay
class PaymentService
object Registry { @JvmStatic fun lookup() {} }
```

```java path=src/app/Checkout.java
package com.acme.app;
import com.acme.pay.PaymentService;
import static com.acme.pay.Registry.lookup;
class Checkout {}
```

## Expect

- src/app/Checkout.java:2 -> node:pay      # Kotlin class through the shared JVM namespace
- src/app/Checkout.java:3 -> node:pay      # static import of a Kotlin object member → the object's declaring file
