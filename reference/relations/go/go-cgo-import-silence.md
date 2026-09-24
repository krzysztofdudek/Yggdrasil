---
id: go-cgo-import-silence
language: go
category: builtin
expectation: silence
cites: "pkg.go.dev/cmd/cgo (`import \"C\"` is the cgo pseudo-package, not a directory)"
---

## Rule

`import "C"` enables cgo. `C` is a pseudo-package the toolchain synthesises from the preamble comment, not a package directory, and it does not start with the module path. The module-prefix gate rejects it, so it never binds a file, not even an in-repo directory named `C`.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/C/c.go
package c
func Decoy() {}
```

```go path=m/native/native.go
package native
// #include <stdio.h>
import "C"
func f() {}
```

## Expect

- silence      # "C" is the cgo pseudo-package → not under module example.com/m → no edge to the decoy node:C

## Why

Binding the pseudo-package to a directory that happens to be named `C` would be a false positive.
