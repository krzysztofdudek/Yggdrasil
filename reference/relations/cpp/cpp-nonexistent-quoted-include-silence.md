---
id: cpp-nonexistent-quoted-include-silence
language: cpp
category: import
expectation: silence
cites: "[cpp.include]/5 (a failed quoted search falls back to the angle header search — i.e. an unseen -I root); research A7; research 2026-09-24 M17 (the no-database probe runs only for multi-segment names without `.`/`..` segments)"
---

## Rule

A quoted `#include "../core/missing.hpp"` whose canonical join does not exist on disk is
SILENCED, not guessed. The extractor emits the specifier (it cannot know existence); the
resolver joins it to the includer's directory (`core/missing.hpp`) and finds no such
file. With no compilation database the resolver probes the repository root and every
`include/` directory, but only for a name of two or more segments with no `.` or `..`
segment: `../core/missing.hpp` is relative to the includer by construction, so it is
never probed, and no same-basename decoy elsewhere can be picked. The `core/` directory
exists (it holds an unrelated header) but `missing.hpp` does not, so the join misses →
silence.

## Files

```cpp path=core/present.hpp
#pragma once
struct Present {};
```

```cpp path=app/main.cpp
#include "../core/missing.hpp"
int main() { return 0; }
```

## Expect

- silence      # `core/missing.hpp` does not exist; the canonical join misses and a `..` path is never probed → no edge

## Why

Probing alternative roots for an includer-relative path could only match a
same-basename decoy, so a resolution miss is silenced and the missed header is a
tolerated false-negative.
