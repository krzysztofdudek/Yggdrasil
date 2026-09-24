---
id: kotlin-same-fqn-two-files-ambiguous-silence
language: kotlin
category: trap
expectation: silence
cites: "Kotlin spec — Packages and imports (one FQN, two definitions); research — ambiguity collapses to SILENCE"
---

## Rule

When two in-graph files declare the SAME fully-qualified name (`com.acme.dup.Thing` in
both), an import of that FQN maps to ≥2 distinct definitions → ambiguous → silence. The
resolver never coin-flips between equally-near candidates; it emits no edge rather than
an arbitrary one.

## Files

```kotlin path=src/x/Thing.kt
package com.acme.dup
class Thing
```

```kotlin path=src/y/Thing.kt
package com.acme.dup
class Thing
```

```kotlin path=src/z/Use.kt
package com.acme.z
import com.acme.dup.Thing
class Use
```

## Expect

- silence      # `com.acme.dup.Thing` is declared in two files → ambiguous → no edge (never an arbitrary pick)

## Why

A genuine ambiguity (also how `expect`/`actual` same-FQN duplicates split across two
nodes collapse; in one node they are an edge, see kotlin-expect-actual-same-node-edge) must
silence, never bind one side arbitrarily — that would be a false positive against the
unpicked node.
