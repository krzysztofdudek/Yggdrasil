---
id: java-test-root-to-main-root-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.1; Maven Standard Directory Layout (src/main/java, src/test/java); research JKC-01 (B3)"
---

## Rule

A test under `src/test/java` imports production classes that live under `src/main/java`. The two roots are siblings, so probing the FQN under the test file's ancestor directories never reaches `src/main/java/<package path>`. The resolver falls back to the JVM symbol table, where the FQN has exactly one declaring file, and the edge goes to its node.

## Files

```java path=src/main/java/com/acme/billing/Invoice.java
package com.acme.billing;
public class Invoice {}
```

```java path=src/test/java/com/acme/it/InvoiceIT.java
package com.acme.it;
import com.acme.billing.Invoice;
import org.junit.jupiter.api.Test;
class InvoiceIT {}
```

## Expect

- src/test/java/com/acme/it/InvoiceIT.java:2 -> node:billing      # test root → main root through the symbol table; the JUnit import stays silent
