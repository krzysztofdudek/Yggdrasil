---
id: cpp-cppm-global-module-fragment-edge
language: cpp
category: import
expectation: edge
cites: "[module.global.frag] (`module;` introduces the global module fragment, where #include is allowed); language-registry (.cppm/.ixx/.mpp module interface units); research 2026-09-24 m29"
---

## Rule

A C++20 module interface unit (`.cppm` for Clang/CMake, `.ixx` for MSVC, `.mpp`) pulls
in legacy headers through `#include` in its global module fragment. The unit is parsed
with the C++ grammar; the shipped grammar does not understand `module;` or
`export module geo;` (they become ordinary declarations or ERROR nodes), but the
include between them is still a `preproc_include` and resolves as usual. The module
declaration itself stays silent (see cpp-export-module-decl-silence).

## Files

```cpp path=libs/hdr/h.hpp
#pragma once
struct H {};
```

```cpp path=libs/geo/geo.cppm
module;
#include "../hdr/h.hpp"
export module geo;
export int area();
```

## Expect

- libs/geo/geo.cppm:2 -> node:hdr      # the global-module-fragment include resolves → libs/hdr/h.hpp (node hdr)

## Why

The header a module unit includes is a real dependency, whatever the grammar makes of
the module syntax around it.
