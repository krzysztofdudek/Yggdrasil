---
id: cpp-angle-system-include-silence
language: cpp
category: builtin
expectation: silence
cites: "[cpp.include]/4 (angle form = header search through the implementation-defined -I path); research A4; research 2026-09-24 M17 (angle includes resolve only under a compilation database -I root)"
---

## Rule

An angle `#include <ext/widget.hpp>` is a HEADER search through the implementation-defined
`-I`/system path — it never searches the includer's directory. The extractor emits it
as `<ext/widget.hpp>`, and the resolver looks an angle include up ONLY under the `-I`
roots of a compilation database; with no database it is silent, and it is never probed.
This is a same-name FP trap: an in-repo `app/ext/widget.hpp` (node `ext`) is
deliberately present, and the canonical join `app/ext/widget.hpp` from the includer in
`app/` WOULD resolve to node `ext` if an angle include were joined like a quoted one.
Without the real `-I` list an in-repo header and a system one look alike, so no edge can
be fabricated (with a database, see cpp-in-repo-angle-include-via-I-edge).

## Files

```cpp path=app/ext/widget.hpp
#pragma once
struct Widget {};
```

```cpp path=app/main.cpp
#include <ext/widget.hpp>
int main() { return 0; }
```

## Expect

- silence      # `#include <ext/widget.hpp>` is an angle include and there is no compilation database → no edge, even though app/ext/widget.hpp exists in-repo

## Why

An angle include is never joined to the includer's directory and never probed: without
the build's `-I` list a system or third-party header reached by `<...>` is
indistinguishable from an in-repo file that shares the name.
