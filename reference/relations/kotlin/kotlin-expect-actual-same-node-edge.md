---
id: kotlin-expect-actual-same-node-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin Multiplatform docs — Expected and actual declarations; research B4 (ambiguity is counted by owner node)"
---

## Rule

An `expect` declaration and its `actual` counterpart carry the SAME fully-qualified name in two files. When both files belong to ONE node, an import of that name has exactly one possible target, so it is an edge to that node: ambiguity is counted by owner node, never by file. The same name split across two nodes stays silent (see kotlin-same-fqn-two-files-ambiguous-silence). A file of that same node whose declarations could not all be read (here a package-wide incompleteness marker from an unreadable declaration) cannot flip the edge to another node, so it does not make the import ambiguous; a damaged file in a different node still does (see kotlin-unrecoverable-decl-fails-closed-silence).

## Files

```kotlin path=src/clock/Clock.kt
package com.acme.clock
expect class Clock {
    fun now(): Long
}
```

```kotlin path=src/clock/ClockJvm.kt
package com.acme.clock
actual class Clock {
    actual fun now(): Long = System.currentTimeMillis()
}
```

```kotlin path=src/clock/Broken.kt
package com.acme.clock
public %% class Timer
```

```kotlin path=src/app/Use.kt
package com.acme.app
import com.acme.clock.Clock
class C(val clock: Clock)
```

## Expect

- src/app/Use.kt:2 -> node:clock      # expect and actual Clock are both in node clock → one target → edge; the unreadable declaration in clock's own Broken.kt cannot point anywhere else

## Why

Silencing here would drop a real dependency for every multiplatform module that keeps its expect and actual declarations in one component, which is the common layout. The ambiguity that must silence is between nodes, never between files of one node.
