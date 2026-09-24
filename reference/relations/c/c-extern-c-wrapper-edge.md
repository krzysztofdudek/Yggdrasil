---
id: c-extern-c-wrapper-edge
language: c
category: import
expectation: edge
cites: "C17 6.10.2 (quoted include); the `extern \"C\"` idiom for headers shared with C++"
---

## Rule

A C header shared with C++ wraps its declarations in `#ifdef __cplusplus` /
`extern "C" {` / `#endif`. Parsed with the C grammar, the `extern "C"` line is inside an
`#ifdef` group and the rest of the file is ordinary C, so an include after the wrapper
is still a plain quoted include. `#ifdef __cplusplus` is an unknown condition, which
the dead-branch guard always treats as live. The header includes
`../core/types.h`, which resolves next to it.

## Files

```c path=core/types.h
#pragma once
typedef int core_id;
```

```c path=api/api.h
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "../core/types.h"
core_id api_open(void);
#ifdef __cplusplus
}
#endif
```

## Expect

- api/api.h:5 -> node:core      # the include inside the extern "C" wrapper resolves to core/types.h (node core)

## Why

The wrapper is a C++ linkage idiom, not a condition that hides the include.
