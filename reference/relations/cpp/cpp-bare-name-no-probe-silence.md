---
id: cpp-bare-name-no-probe-silence
language: cpp
category: trap
expectation: silence
cites: "research 2026-09-24 M17 (the probe only runs for multi-segment paths)"
---

## Rule

A single-segment quoted include such as `"config.h"` that misses next to the includer
is never probed. Bare names are what generated headers (`config.h` written into the
build tree) and foreign headers are called, and a same-named file somewhere under an
`include/` directory is exactly the decoy the probe must not bind. The only in-repo
`config.hpp` here sits in `libs/core/include/`, and the include stays silent.

## Files

```cpp path=libs/core/include/config.hpp
#pragma once
struct Config {};
```

```cpp path=apps/server/main.cpp
#include "config.hpp"
int main() { return 0; }
```

## Expect

- silence      # a one-segment path is not probed → no edge, though libs/core/include/config.hpp exists

## Why

The shorter the path, the likelier a same-named decoy; the probe needs a directory
segment to have any evidence at all.
