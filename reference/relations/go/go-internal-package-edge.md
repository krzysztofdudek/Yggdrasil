---
id: go-internal-package-edge
language: go
category: import
expectation: edge
cites: "go.dev/doc/go1.4#internalpackages (an `internal` path element restricts importers; the import still names a directory)"
---

## Rule

`internal/` only restricts who may import a package; it does not change how the path maps to a directory. `example.com/m/internal/store` binds `m/internal/store/store.go` (node `store`).

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/internal/store/store.go
package store
func Open() {}
```

```go path=m/app/main.go
package main
import "example.com/m/internal/store"
func main() { store.Open() }
```

## Expect

- m/app/main.go:2 -> node:store      # internal/ is an ordinary path element for resolution → m/internal/store/

## Why

Internal packages are where most of a module's implementation lives, so they are frequent targets of cross-node imports.
