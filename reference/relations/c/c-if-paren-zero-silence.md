---
id: c-if-paren-zero-silence
language: c
category: trap
expectation: silence
cites: "C17 6.10.1 (a controlling expression is an integer constant expression; `(0)` is the constant 0); research 2026-09-24 m33"
---

## Rule

`#if (0)` is exactly as dead as `#if 0`: the parentheses do not change the value of the
integer constant expression. The dead-branch guard evaluates the condition as a
constant expression built from literals only (numbers, `true`/`false`, parentheses and
the arithmetic, comparison and logical operators), so `(0)`, `0 && X`, `!1` and `0x0`
are all recognised as dead. An identifier other than `true`/`false` (a macro), a
`defined(...)` test or a `__has_include(...)` probe makes the value unknown, and an
unknown condition is always treated as live. Here the header really exists in another
node, so an edge would be a false positive for code the compiler discards.

## Files

```c path=core/dead.h
#pragma once
struct Dead { int n; };
```

```c path=app/main.c
#if (0)
#include "../core/dead.h"
#endif
int main(void) { return 0; }
```

## Expect

- silence      # `#if (0)` is the constant 0 → the include sits in a dead branch → no edge, though core/dead.h exists

## Why

A parenthesised zero is the same constant the compiler evaluates to false; emitting an
edge for it was a false positive from reading only the bare `0` literal as dead.
