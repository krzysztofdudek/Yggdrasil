---
id: kotlin-imports-java-class-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin docs — Calling Java from Kotlin; Kotlin spec — Packages and imports; research KT-03 (M14)"
---

## Rule

Kotlin and Java share one JVM namespace, so a Kotlin `import` of a Java class resolves against the Java declarations exactly as it resolves against Kotlin ones, including a nested Java type through the guarded `+` split. A Java class declared twice stays ambiguous, as in Kotlin.

## Files

```java path=src/j/JavaSvc.java
package com.app.j;
public class JavaSvc {
    public static class Options {}
}
```

```kotlin path=src/k/Use.kt
package com.app.k
import com.app.j.JavaSvc
import com.app.j.JavaSvc.Options
class Use
```

## Expect

- src/k/Use.kt:2 -> node:j      # Java class through the shared JVM namespace
- src/k/Use.kt:3 -> node:j      # nested Java class through the `+` split
