---
id: cpp-in-repo-angle-include-via-I-edge
language: cpp
category: import
expectation: edge
cites: "[cpp.include]/2 (an angle include searches the implementation-defined list, i.e. the -I roots); research 2026-09-24 M17"
---

## Rule

An angle include `#include <util/log.hpp>` never searches the includer's directory; it
searches the `-I` roots (not `-iquote`). With a compilation database present, the
extractor emits the angle include and the resolver looks it up under the translation
unit's `-I` roots only, with the exactly-one-hit rule. Without a compilation database
an angle include stays silent (see cpp-angle-system-include-silence): without the real
`-I` list there is no way to tell an in-repo header from a system one.

## Files

```cpp path=libs/util/include/util/log.hpp
#pragma once
struct Log {};
```

```cpp path=apps/server/main.cpp
#include <vector>
#include <util/log.hpp>
int main() { return 0; }
```

```json path=compile_commands.json
[
  { "directory": ".", "file": "apps/server/main.cpp",
    "command": "c++ -I libs/util/include -isystem /usr/include -c apps/server/main.cpp" }
]
```

## Expect

- apps/server/main.cpp:2 -> node:util      # `<util/log.hpp>` resolves under the -I root libs/util/include (node util); `<vector>` is under no in-repo root → silent

## Why

The angle form is how most CMake projects include another target's public headers; the
database's `-I` list makes it as precise as a quoted include.
