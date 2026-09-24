---
id: cpp-root-relative-google-style-edge
language: cpp
category: import
expectation: edge
cites: "Google C++ Style Guide, Names and Order of Includes (paths relative to the project's source root); research 2026-09-24 M17"
---

## Rule

Without a compilation database, a quoted include that misses next to the includer is
probed under a fixed set of common include roots: the repository root and every
directory named `include`. The probe is conservative: it runs only for a path of at
least two segments with no `.` or `..` segment (a bare `"config.h"` is never probed,
since it is the most likely name for a generated or foreign header), and it resolves
only when exactly one root holds the file. Google-style `"base/logging.h"` written
relative to the source root resolves at the repository root.

## Files

```cpp path=base/logging.hpp
#pragma once
struct Logger {};
```

```cpp path=net/server/server.cpp
#include "base/logging.hpp"
int serve() { Logger l; return 0; }
```

## Expect

- net/server/server.cpp:1 -> node:base      # no `base/` next to the includer; the only probe hit is <root>/base/logging.hpp (node base)

## Why

Root-relative includes are the documented convention of large codebases; with exactly
one candidate there is nothing to guess.
