---
id: kotlin-toplevel-overload-multi-file-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (an import of a callable name brings in every overload); research B4 (ambiguity is counted by owner node)"
---

## Rule

Top-level functions of one package may be overloaded across files: `fun format(v: Int)` in one file, `fun format(v: String)` in another. `import com.acme.text.format` brings in every overload under that name, so the name has several defining files. When they all belong to ONE node, the import is an edge to that node. When the overloads live in two different nodes, the import names both and stays silent.

## Files

```kotlin path=src/text/IntFormat.kt
package com.acme.text
fun format(v: Int): String = v.toString()
```

```kotlin path=src/text/StringFormat.kt
package com.acme.text
fun format(v: String): String = v.trim()
```

```kotlin path=src/shared/ParseA.kt
package com.acme.parse
fun parse(v: String): Int = v.length
```

```kotlin path=src/other/ParseB.kt
package com.acme.parse
fun parse(v: ByteArray): Int = v.size
```

```kotlin path=src/app/Use.kt
package com.acme.app
import com.acme.text.format
import com.acme.parse.parse
fun show() = format(1) + parse("x")
```

## Expect

- src/app/Use.kt:2 -> node:text      # both overloads of format are in node text → one target → edge; line 3 emits nothing: the overloads of parse are split across nodes shared and other → ambiguous

## Why

An overload set spread over the files of one component is one dependency. Only a split across components leaves the target unknown.
