---
id: kotlin-local-val-not-a-top-level-key
language: kotlin
category: trap
expectation: edge
cites: "Kotlin spec — Declarations: local declarations are not visible outside their scope; research KT-04 (M15)"
---

## Rule

A declaration inside a function body, lambda, `init` block, property accessor, secondary constructor or object expression is LOCAL: it cannot be imported and has no FQN. It must not be indexed as a top-level key. Otherwise a local `val format` in one node collides with the real top-level `fun format` another node exports, the import turns ambiguous, and a real edge goes silent.

## Files

```kotlin path=src/u/Format.kt
package com.acme.util
fun format(v: Int): String = v.toString()
```

```kotlin path=src/r/Report.kt
package com.acme.util
class Report {
    fun render(): String {
        val format = "%d"
        class Row
        fun format() = 1
        return format
    }
    init { val format = 2 }
}
fun build() = listOf(1).map { val format = it; format }
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.util.format
class C
```

## Expect

- src/c/Use.kt:2 -> node:u      # only u declares a top-level com.acme.util.format; r's locals are not keys
