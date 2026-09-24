---
id: cpp-if-one-else-dead-silence
language: cpp
category: trap
expectation: silence
cites: "[cpp.cond]/13 (only the first group whose condition is true is processed; the #else group is skipped)"
---

## Rule

`#if 1` is taken, so its `#else` group is dead. The guard treats the `alternative` of a
known non-zero condition as dead, the mirror of the `#if 0` rule that keeps the `#else`
of a dead `#if 0` live (cpp-dead-if-zero-else-live-edge). The live body's include is
kept.

## Files

```cpp path=core/old.hpp
#pragma once
struct Old {};
```

```cpp path=app/main.cpp
#if 1
int live();
#else
#include "../core/old.hpp"
#endif
int main() { return 0; }
```

## Expect

- silence      # the `#else` of a taken `#if 1` is dead → no edge to core

## Why

Code in the skipped `#else` is never compiled, so its include is not a dependency.
