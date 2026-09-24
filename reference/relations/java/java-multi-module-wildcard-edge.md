---
id: java-multi-module-wildcard-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.2 type-import-on-demand; Maven multi-module layout; research JKC-01 (B3)"
---

## Rule

A type-import-on-demand `import a.b.*;` whose package lives in a SIBLING module's source root is not found by the importing file's ancestor-directory probe. The resolver falls back to the JVM symbol table's package index: every graph file that declares a top-level type of package `a.b`, collapsed by owner exactly like the on-disk wildcard (one owner → the edge; zero or two or more owners → silence).

## Files

```java path=audit-module/src/main/java/com/acme/audit/AuditLog.java
package com.acme.audit;
public class AuditLog {}
```

```java path=audit-module/src/main/java/com/acme/audit/AuditWriter.java
package com.acme.audit;
public class AuditWriter {}
```

```java path=app-module/src/main/java/com/acme/app/Use.java
package com.acme.app;
import com.acme.audit.*;
class Use {}
```

## Expect

- app-module/src/main/java/com/acme/app/Use.java:2 -> node:audit      # the sibling module's package has one owner → one edge
