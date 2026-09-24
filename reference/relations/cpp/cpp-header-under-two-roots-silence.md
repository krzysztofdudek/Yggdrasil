---
id: cpp-header-under-two-roots-silence
language: cpp
category: trap
expectation: silence
cites: "[cpp.include] (the first root wins, which depends on flag order a header-only lookup cannot always see); research 2026-09-24 M17 (the PSR-4 exactly-one-hit rule applied to include roots)"
---

## Rule

When the same relative header exists under two of a translation unit's include roots,
the compiler picks the first root in flag order. The resolver does not bet on that
order (a header included from another header takes the roots of whichever unit
includes it): 2+ distinct hits are ambiguous and stay silent. Here both
`libs/a/include` and `libs/b/include` hold `common/config.hpp`.

## Files

```cpp path=libs/a/include/common/config.hpp
#pragma once
struct ConfigA {};
```

```cpp path=libs/b/include/common/config.hpp
#pragma once
struct ConfigB {};
```

```cpp path=apps/server/main.cpp
#include "common/config.hpp"
int main() { return 0; }
```

```json path=compile_commands.json
[
  { "directory": ".", "file": "apps/server/main.cpp",
    "arguments": ["c++", "-Ilibs/a/include", "-Ilibs/b/include", "-c", "apps/server/main.cpp"] }
]
```

## Expect

- silence      # `common/config.hpp` exists under two -I roots → ambiguous → no edge to either node

## Why

Two candidate owners and no certainty which one the compiler takes for every includer:
silence, never first-wins.
