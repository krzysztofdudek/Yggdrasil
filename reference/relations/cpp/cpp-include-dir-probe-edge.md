---
id: cpp-include-dir-probe-edge
language: cpp
category: import
expectation: edge
cites: "CMake target_include_directories(<t> PUBLIC include) convention; research 2026-09-24 M17"
---

## Rule

Without a compilation database, every directory named `include` is one of the probe
roots, which covers the CMake convention of a library publishing
`libs/<lib>/include/<lib>/*.hpp`. `"net/socket.hpp"` misses next to the includer and
has exactly one probe hit, `libs/net/include/net/socket.hpp`.

## Files

```cpp path=libs/net/include/net/socket.hpp
#pragma once
struct Socket {};
```

```cpp path=apps/server/main.cpp
#include "net/socket.hpp"
int main() { Socket s; return 0; }
```

## Expect

- apps/server/main.cpp:1 -> node:net      # the only probe hit is libs/net/include/net/socket.hpp (node net)

## Why

One candidate under the conventional public-header root is the header the build uses.
