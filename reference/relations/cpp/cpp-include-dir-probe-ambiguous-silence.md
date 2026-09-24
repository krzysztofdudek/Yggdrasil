---
id: cpp-include-dir-probe-ambiguous-silence
language: cpp
category: trap
expectation: silence
cites: "research 2026-09-24 M17 (exactly-one-hit rule for the probe)"
---

## Rule

The probe counts hits across all its roots. `"util/string.hpp"` exists under the
repository root (`util/string.hpp`) and under `third_party/fmt/include`; with two
candidates the probe cannot know which `-I` the build uses, so it stays silent.

## Files

```cpp path=util/string.hpp
#pragma once
struct Str {};
```

```cpp path=third_party/fmt/include/util/string.hpp
#pragma once
struct FmtStr {};
```

```cpp path=apps/server/main.cpp
#include "util/string.hpp"
int main() { return 0; }
```

## Expect

- silence      # two probe hits (repository root and third_party/fmt/include) → ambiguous → no edge

## Why

Without the real include list, two candidates are two guesses; silence is the only
answer that cannot be wrong.
