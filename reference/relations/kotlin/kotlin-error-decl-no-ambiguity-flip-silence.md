---
id: kotlin-error-decl-no-ambiguity-flip-silence
language: kotlin
category: trap
expectation: silence
cites: "Kotlin spec — Packages and imports (ambiguous import); research GF-1 + KT-01 (B1, ambiguity flip)"
---

## Rule

Two files declare the same FQN `com.acme.Thing`, so an import of it is ambiguous and must stay silent. When one of the two files also holds syntax the grammar cannot parse (here a when-guard above `class Thing`), losing its declaration would leave the other file as the unique definer and flip the silence into a wrong edge. Recovery re-indexes `Thing` in the damaged file, so the import stays ambiguous. When a damaged top-level declaration cannot be recovered at all, the file declares a package-wide "incomplete" marker instead: any import into that package that would otherwise bind to a different file stays silent (fail closed), and the marker alone never creates an edge.

## Files

```kotlin path=src/x/Thing.kt
package com.acme
fun kind(v: Any) = when (v) {
    is Int if v > 0 -> "positive"
    else -> "other"
}
class Thing
```

```kotlin path=src/y/Thing.kt
package com.acme
class Thing
```

```kotlin path=src/z/Use.kt
package com.acme.app
import com.acme.Thing
class C
```

## Expect

- silence      # com.acme.Thing is declared by x AND y → ambiguous; the when-guard in x must not erase x's declaration and flip this into an edge to y

## Why

A parse gap is a reason to know less, never a reason to be more certain. Any declaration the extractor could not read keeps the ambiguity it would have created.
