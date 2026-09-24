---
id: java-multi-module-sibling-import-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.1 single-type-import; Maven multi-module / Gradle multi-project layout; research JKC-01 (B3)"
---

## Rule

In a Maven or Gradle multi-module build every module has its own source root (`<module>/src/main/java`), and a module imports the classes of a sibling module it depends on. The importing file's own ancestor directories never contain the sibling's source root, so the package = directory probe misses. The resolver then falls back to the shared JVM symbol table: the imported FQN names exactly one declaring file anywhere in the graph, so the edge goes to that file's node. A miss there (the FQN is declared nowhere, as for a library class) stays silent, and a FQN declared by two files stays silent too (see java-multi-module-duplicate-fqn-silence).

## Files

```java path=billing-module/src/main/java/com/acme/billing/Invoice.java
package com.acme.billing;
public class Invoice {}
```

```java path=app-module/src/main/java/com/acme/app/Checkout.java
package com.acme.app;
import com.acme.billing.Invoice;
import org.slf4j.Logger;
class Checkout {}
```

## Expect

- app-module/src/main/java/com/acme/app/Checkout.java:2 -> node:billing      # sibling module's class, found through the symbol table after the source-root probe misses
