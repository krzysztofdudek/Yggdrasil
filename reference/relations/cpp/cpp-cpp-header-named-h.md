---
id: cpp-cpp-header-named-h
language: cpp
category: trap
expectation: edge
cites: "language-registry (`.h` routes to C++ when the header has a C++ sibling); research 2026-09-24 m31"
---

## Rule

`.h` is used for both C and C++ headers (the Google C++ style default). A `.h` file is
parsed with the C++ grammar when its directory holds a C++ source or header
(`.cpp`, `.cc`, `.cxx`, `.hpp`, …) and no C source (`.c`); otherwise it stays C. Parsed
as C, a C++ header with a template class and `final` produces ERROR nodes, which can
bury an include that follows; parsed as C++, the tree is clean and the include after
the class resolves.

## Files

```cpp path=libs/hdr/h.hpp
#pragma once
struct H {};
```

```cpp path=libs/widget/widget.h
#pragma once
namespace ui {
template <typename T> class Widget final : public Base<T> {
 public:
  ~Widget() override = default;
};
}
#include "../hdr/h.hpp"
```

```cpp path=libs/widget/widget.cpp
#include "widget.h"
```

## Expect

- libs/widget/widget.h:8 -> node:hdr      # the `.h` has a .cpp sibling → parsed as C++ → the include after the template resolves (node hdr)

## Why

A C++ header should be read with the C++ grammar; the sibling sources say which
language the directory is written in.
