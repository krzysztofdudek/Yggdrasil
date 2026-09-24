---
id: c-has-include-elif-zero-silence
language: c
category: trap
expectation: silence
cites: "C23 6.10.1 (`__has_include`); research 2026-09-24 m33 (the grammar collapses `#if __has_include(...)` into an ERROR node and flattens the chain)"
---

## Rule

Both shipped grammars misparse `#if __has_include("x.h")`: the directive becomes an
ERROR node and the rest of the conditional chain is flattened into plain siblings, so
the tree no longer shows that `#include "../core/dead.h"` sits under `#elif 0`. When a
file's tree contains an ERROR node, the dead-branch guard also scans the preprocessor
directives line by line (tracking `#if`/`#ifdef`/`#elif`/`#else`/`#endif` nesting, with
comments and string literals blanked) and drops an include whose branch is dead by a
constant condition. The `__has_include` branch itself is unknown and stays live; the
`#elif 0` branch is dead.

## Files

```c path=core/dead.h
#pragma once
struct Dead { int n; };
```

```c path=app/main.c
#if __has_include("opt.h")
#include "opt.h"
#elif 0
#include "../core/dead.h"
#endif
int main(void) { return 0; }
```

## Expect

- silence      # the `#elif 0` branch is dead; `opt.h` does not exist next to the includer → no edge at all

## Why

The compiler never sees the `#elif 0` body. Reading the flattened tree as if the include
were unconditional produced a false edge to `core`.
