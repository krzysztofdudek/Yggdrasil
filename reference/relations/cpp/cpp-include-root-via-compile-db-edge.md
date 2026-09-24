---
id: cpp-include-root-via-compile-db-edge
language: cpp
category: import
expectation: edge
cites: "[cpp.include]/2-3 (a quoted include searches the includer's directory, then the -iquote/-I list); the JSON Compilation Database format (clang.llvm.org/docs/JSONCompilationDatabase.html); research 2026-09-24 M17"
---

## Rule

Real projects reach another library's headers through the compiler's `-I` list, not
through a path relative to the includer. When a `compile_commands.json` sits at the
repository root or in `build/`, the resolver reads it: each entry's `-iquote`, `-I`
(also `-I <dir>`, `--include-directory=`, `/I`) flags, resolved against the entry's
`directory`, become the include roots of that translation unit. `-isystem` roots and
roots outside the repository are ignored. A quoted include that misses next to the
includer is then looked up under those roots, and resolves only when EXACTLY ONE root
holds the header. Here `apps/server/main.cpp` is compiled with
`-Ilibs/net/include`, so `"net/socket.hpp"` is `libs/net/include/net/socket.hpp`.
(`directory` may be relative to the database's own directory; tools normally write an
absolute path.)

## Files

```cpp path=libs/net/include/net/socket.hpp
#pragma once
struct Socket {};
```

```cpp path=apps/server/main.cpp
#include "net/socket.hpp"
int main() { Socket s; return 0; }
```

```json path=compile_commands.json
[
  { "directory": ".", "file": "apps/server/main.cpp",
    "arguments": ["c++", "-Ilibs/net/include", "-c", "apps/server/main.cpp"] }
]
```

## Expect

- apps/server/main.cpp:1 -> node:net      # `net/socket.hpp` resolves through the compile database's -I root → libs/net/include/net/socket.hpp (node net)

## Why

The compilation database holds the flags the compiler actually used, so resolving
through its roots names the header the compiler picks, not a guess.
