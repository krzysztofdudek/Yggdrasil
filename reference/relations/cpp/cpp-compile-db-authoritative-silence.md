---
id: cpp-compile-db-authoritative-silence
language: cpp
category: trap
expectation: silence
cites: "the JSON Compilation Database format; research 2026-09-24 M17"
---

## Rule

When a compilation database exists, its roots are the whole truth: the resolver does
not also probe the repository's `include/` directories or its root. Here the database
gives `apps/server/main.cpp` no `-I` root at all, so `"net/socket.hpp"` does not
resolve, even though `libs/net/include/net/socket.hpp` exists and the probe used when
no database is present would have found it.

## Files

```cpp path=libs/net/include/net/socket.hpp
#pragma once
struct Socket {};
```

```cpp path=apps/server/main.cpp
#include "net/socket.hpp"
int main() { return 0; }
```

```json path=build/compile_commands.json
[
  { "directory": "..", "file": "apps/server/main.cpp",
    "arguments": ["c++", "-c", "apps/server/main.cpp"] }
]
```

## Expect

- silence      # the database lists no include root for this unit → no probe, no edge

## Why

A database describes the build; guessing past it could only name a header the compiler
does not use.
