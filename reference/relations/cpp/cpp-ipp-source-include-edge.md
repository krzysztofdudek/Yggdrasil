---
id: cpp-ipp-source-include-edge
language: cpp
category: import
expectation: edge
cites: "language-registry (C++ extensions: .ipp/.inl/.tpp/.txx template implementation files); research 2026-09-24 m29"
---

## Rule

Template implementation files (`.ipp`, `.inl`, `.tpp`, `.txx`) are C++ and are parsed
with the C++ grammar. Before they were registered, their includes were never read, so a
dependency written only there was invisible. `libs/tmpl/detail/impl.ipp` includes
`../../hdr/h.hpp`.

## Files

```cpp path=libs/hdr/h.hpp
#pragma once
struct H {};
```

```cpp path=libs/tmpl/detail/impl.ipp
#include "../../hdr/h.hpp"
template <typename T> T twice(T t) { return t + t; }
```

## Expect

- libs/tmpl/detail/impl.ipp:1 -> node:hdr      # the .ipp file is parsed as C++ → libs/hdr/h.hpp (node hdr)

## Why

A header-only library's dependencies live in these files as much as in its `.hpp`.
