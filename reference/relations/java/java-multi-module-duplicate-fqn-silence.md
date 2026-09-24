---
id: java-multi-module-duplicate-fqn-silence
language: java
category: trap
expectation: silence
cites: "JLS SE25 §7.5.1; Maven multi-module layout; research JKC-01 (B3)"
---

## Rule

The cross-module fallback binds only a FQN that exactly one graph file declares. When two modules each declare the same FQN (a copied class, a test double that shadows a main class, two services each shipping their own `com.acme.shared.Config`), a source-only tool cannot see which one the importing module's build classpath contains, so the import stays silent rather than guess. (Each copy sits under a module-named directory so that the harness, which names a node after a file's parent directory, puts the two copies in two different nodes.)

## Files

```java path=svc-a/src/main/java/com/acme/sharedA/Config.java
package com.acme.shared;
public class Config {}
```

```java path=svc-b/src/main/java/com/acme/sharedB/Config.java
package com.acme.shared;
public class Config {}
```

```java path=app-module/src/main/java/com/acme/app/Use.java
package com.acme.app;
import com.acme.shared.Config;
class Use {}
```

## Expect

- silence      # two modules declare com.acme.shared.Config → ambiguous → no edge

## Why

Picking either declaration would be a guess about the build classpath that the source cannot answer; a wrong edge is worse than a missed one.
