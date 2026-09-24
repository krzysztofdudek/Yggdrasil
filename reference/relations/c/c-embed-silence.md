---
id: c-embed-silence
language: c
category: builtin
expectation: silence
cites: "C23 6.10.4 (`#embed` inserts a resource's bytes; it is not a source include)"
---

## Rule

`#embed "logo.bin"` pastes the bytes of a resource into an initializer. It names a data
file, not a translation-unit dependency on another component's code, and the grammar
parses it as a generic `preproc_call`, never a `preproc_include`. The extractor reads
only `preproc_include`, so it emits nothing even when the resource sits in another
node's directory.

## Files

```c path=assets/logo.h
#pragma once
extern const unsigned char logo[];
```

```c path=app/main.c
const unsigned char blob[] = {
#embed "../assets/logo.h"
};
int main(void) { return 0; }
```

## Expect

- silence      # `#embed` is a resource inclusion, not a code dependency → no edge

## Why

Embedding bytes creates no dependency on the code of another component.
