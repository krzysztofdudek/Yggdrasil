---
id: cpp-backslash-include-edge
language: cpp
category: import
expectation: edge
cites: "[lex.header]/2 (backslash in a header-name is implementation-defined); MSVC accepts `\\` and `/` as separators; research 2026-09-24 m35"
---

## Rule

MSVC-style includes write the path with backslashes. A header-name is not a string
literal, so `\l` is not an escape: the resolver reads the raw text between the quotes
and turns every `\` into `/` before joining it to the includer's directory.
`"..\..\libs\hdr\h.hpp"` from `apps/win/main.cpp` is `libs/hdr/h.hpp`.

## Files

```cpp path=libs/hdr/h.hpp
#pragma once
struct H {};
```

```cpp path=apps/win/main.cpp
#include "..\..\libs\hdr\h.hpp"
int main() { H h; return 0; }
```

## Expect

- apps/win/main.cpp:1 -> node:hdr      # backslashes normalised to `/` → libs/hdr/h.hpp (node hdr)

## Why

The same header written with either separator is the same dependency.
