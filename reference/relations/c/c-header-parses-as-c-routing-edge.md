---
id: c-header-parses-as-c-routing-edge
language: c
category: import
expectation: edge
cites: "language-registry (`.c`/`.h` → C grammar; `.cpp`/`.hpp`/… → C++ grammar); research E1 (the C/C++ split is irrelevant to path resolution — shared includeUses + shared resolver)"
---

## Rule

The `.c` and `.h` extensions bind the C grammar; `.cpp`/`.hpp`/… bind the C++ grammar.
Both grammars route `#include` extraction through the SAME shared helper and the same
canonical-join resolver — the `preproc_include` node and its `path` field are identical
across tree-sitter-c and tree-sitter-cpp, and the resolver is pure path arithmetic that
never reads the extension. So a `.c` file's quoted include resolves exactly like a
`.cpp` file's. Here a `.c` includer in `app/` does `#include "../shared/config.h"`; the
`.h` header parses under the C grammar and the include resolves to `shared/config.h`
(node `shared`) — the C/C++ routing distinction does not affect the edge.

## Files

```c path=shared/config.h
#pragma once
struct Config { int n; };
```

```c path=app/main.c
#include "../shared/config.h"
int main(void) { struct Config c; return 0; }
```

## Expect

- app/main.c:1 -> node:shared      # a `.c` includer + a `.h` header (both C grammar) resolve via the shared join → shared/config.h (node shared)

## Why

The `.h`→C vs `.cpp`/`.hpp`→C++ grammar split is irrelevant to path resolution: the
include node, the path field, and the canonical join are identical, so a C-grammar file
emits and resolves a quoted include byte-identically to a C++-grammar file.
