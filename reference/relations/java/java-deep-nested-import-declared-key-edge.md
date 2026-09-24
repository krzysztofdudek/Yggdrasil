---
id: java-deep-nested-import-declared-key-edge
language: java
category: nested
expectation: edge
cites: "JLS SE25 §7.5.1; research D1' (C19 in 06-14); research JKC-01 (B3)"
---

## Rule

The path probe drops EXACTLY one trailing segment for a nested import: a doubly-nested `import com.acme.Outer.Mid.Deep;` tries `com/acme/Outer/Mid/Deep.java`, then `com/acme/Outer/Mid.java`, and never drops further to `com/acme/Outer.java` (guessing at the file by trimming more segments would over-reach). After that miss the import resolves through the JVM symbol table instead, where the nested type is declared under the exact key `com.acme.Outer+Mid+Deep`: the guarded `+` split only splits at a DECLARED type (`com.acme.Outer`), so the binding is exact, not a guess. This replaces the former one-level-limit silence, which was a tolerated missed edge.

## Files

```java path=src/main/java/com/acme/Outer.java
package com.acme;
public class Outer {
  public static class Mid {
    public interface Deep {}
  }
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.Outer.Mid.Deep;
import com.acme.Outer.Mid.Missing;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:acme      # declared nested key com.acme.Outer+Mid+Deep → Outer.java; line 3: com.acme.Outer+Mid+Missing is declared nowhere → silence (no trimming to Outer.java)
