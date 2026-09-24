---
id: cpp-if-false-silence
language: cpp
category: trap
expectation: silence
cites: "[cpp.cond]/10 (`true` and `false` keep their boolean values in a #if expression); research 2026-09-24 m33"
---

## Rule

In C++ `false` in a `#if` expression is the boolean literal, never a macro, so
`#if false` is as dead as `#if 0`. The dead-branch guard's constant evaluator reads
`true` and `false` as 1 and 0. (In C they are macros from `<stdbool.h>` with the same
values, or keywords in C23.)

## Files

```cpp path=core/dead.hpp
#pragma once
struct Dead {};
```

```cpp path=app/main.cpp
#if false
#include "../core/dead.hpp"
#endif
int main() { return 0; }
```

## Expect

- silence      # `#if false` is constant 0 → dead branch → no edge, though core/dead.hpp exists

## Why

The branch is discarded by the compiler; an edge for it was a false positive.
