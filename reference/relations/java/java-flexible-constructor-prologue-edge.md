---
id: java-flexible-constructor-prologue-edge
language: java
category: trap
expectation: edge
cites: "JEP 513 Flexible Constructor Bodies (Java 25); research m8"
---

## Rule

Java 25 lets a constructor run statements before `super(…)` / `this(…)` (a flexible constructor prologue). The shipped tree-sitter-java grammar predates JEP 513 and reports a local parse error around the early statements, but the error stays inside the constructor body: the imports above it and the declarations after it keep their normal nodes, so the file's import edges survive.

## Files

```java path=src/main/java/com/acme/billing/Invoice.java
package com.acme.billing;
public class Invoice {}
```

```java path=src/main/java/com/acme/app/Checkout.java
package com.acme.app;
import com.acme.billing.Invoice;
class Checkout extends Base {
    Checkout(int total) {
        if (total < 0) throw new IllegalArgumentException();
        super(total);
    }
}
```

## Expect

- src/main/java/com/acme/app/Checkout.java:2 -> node:billing      # the prologue's parse gap never reaches the import
