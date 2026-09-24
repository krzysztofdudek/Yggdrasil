---
id: kotlin-unrecoverable-decl-fails-closed-silence
language: kotlin
category: trap
expectation: silence
cites: "Kotlin spec — Packages and imports; research GF-1 + KT-01 (B1, fail closed)"
---

## Rule

When a top-level declaration still fails to parse after the known new syntax is blanked, and its name cannot be read from its leading tokens either, the file may declare anything in its package. It then declares a package-wide incomplete marker: an import into that package that would bind to another file stays silent, because the damaged file might declare the same name. The marker never binds on its own, so an import of a name nobody else declares stays silent too. Here the unreadable declaration carries a token no Kotlin version has (`%%`), standing in for any future syntax the shipped grammar lacks: the modifier `public` is read, then the header reader stops, so the name `Thing` behind it is never trusted.

## Files

```kotlin path=src/x/Broken.kt
package com.acme
public %% class Thing
class Other
```

```kotlin path=src/y/Thing.kt
package com.acme
class Thing
```

```kotlin path=src/z/Use.kt
package com.acme.app
import com.acme.Thing
import com.acme.Nowhere
class C
```

## Expect

- silence      # line 2: x's damaged declaration may be com.acme.Thing → the import into com.acme fails closed; line 3: nobody declares com.acme.Nowhere; the marker alone never binds → silence

## Why

Without the marker the only visible definer is y, and an edge to y would rest on a declaration the tool could not read in x.
