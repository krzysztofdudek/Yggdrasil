---
id: c-elifdef-dead-branch
language: c
category: trap
expectation: silence
cites: "C23 6.10.1 (`#elifdef`); C17 6.10.1/6 (once a group's condition is true, every later group of the chain is skipped)"
---

## Rule

In a conditional chain, once a group's condition is a known non-zero constant, every
later group (`#elif`, `#elifdef`, `#elifndef`, `#else`) is skipped by the compiler no
matter what its own condition says. `#if 1` is taken, so the `#elifdef FEATURE` body is
dead and its include is dropped. tree-sitter-c parses `#elifdef` as a `preproc_elifdef`
in the `alternative` of the `#if 1`, and the guard treats the alternative of a
known-true condition as dead.

## Files

```c path=core/feature.h
#pragma once
struct Feature { int n; };
```

```c path=app/main.c
#if 1
int live;
#elifdef FEATURE
#include "../core/feature.h"
#endif
int main(void) { return 0; }
```

## Expect

- silence      # `#if 1` is taken, so the `#elifdef FEATURE` branch is dead → no edge to core

## Why

The alternative of a taken branch is never compiled; its include is not a dependency.
