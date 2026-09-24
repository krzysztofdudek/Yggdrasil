---
id: cpp-dead-if-zero-include-silence
language: cpp
category: import
expectation: silence
cites: "[cpp.cond] (a literal `0` controlling expression is unconditionally false); research D1 (the `#if 0` dead-branch include is the ONE statically-known-dead preprocessor case — the sealed FP)"
---

## Rule

A literal `#if 0` is unconditionally false: the branch is never compiled, so an
`#include` in its dead body carries NO real dependency. A condition built from literals
only is the preprocessor state a source-only tool can resolve with certainty (no macro
state needed; see c-if-paren-zero-silence and cpp-if-false-silence for the wider set).
The extractor walks the include's ancestor chain, finds the enclosing `preproc_if` whose
condition evaluates to 0 with the include in its dead body (not its `alternative`), and
SKIPS emission. Here `../core/dead.hpp` is a REAL file (node
`core`) — so WITHOUT the seal this would emit a spurious cross-node edge `app -> core`
for code the compiler discards, a genuine false positive. With the seal, the dead-body
include emits nothing → silence.

## Files

```cpp path=core/dead.hpp
#pragma once
struct Dead {};
```

```cpp path=app/main.cpp
#if 0
#include "../core/dead.hpp"
#endif
int main() { return 0; }
```

## Expect

- silence      # the `#include` sits in the dead body of a literal `#if 0` → skipped at emission, even though core/dead.hpp exists

## Why

Emitting an edge for an include the compiler never sees is itself a false positive; the
literal-`0` branch is statically-known-dead, so skipping its include is the spec-correct,
zero-FP behavior. Every live conditional (`#ifdef`, `#if 1`, `#if defined(...)`) is kept.
