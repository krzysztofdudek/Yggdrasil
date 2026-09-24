---
id: go-go-work-workspace-edge
language: go
category: import
expectation: edge
cites: "go.dev/ref/mod — Workspaces (go.work `use` directives make each listed module a main module; imports of their packages resolve to the in-workspace directories)"
---

## Rule

A `go.work` workspace with `use (./a ./b)` makes both modules main modules, so a file in module `a` that imports `example.com/b/lib` gets the in-workspace directory `ws/b/lib/`. The resolver reads the nearest `go.work` above the importing file, indexes the module path of every `use` member (from that member's own go.mod), and resolves the import against the LONGEST module path that prefixes it. `example.com/b/lib` matches member `b` (`example.com/b`), so it binds `ws/b/lib/lib.go` (node `lib`). Module paths are unique within a workspace, so the match is deterministic.

## Files

```go path=ws/go.work
go 1.21

use (
  ./a
  ./b
)
```

```go path=ws/a/go.mod
module example.com/a
```

```go path=ws/b/go.mod
module example.com/b
```

```go path=ws/b/lib/lib.go
package lib
func Use() {}
```

```go path=ws/a/app/main.go
package main
import "example.com/b/lib"
func main() { lib.Use() }
```

## Expect

- ws/a/app/main.go:2 -> node:lib      # example.com/b/lib → workspace member b (example.com/b) → ws/b/lib/

## Why

Workspaces are the standard way to split a large Go codebase, and the member boundary is usually the node boundary, so silencing cross-member imports hid exactly the dependencies worth enforcing.
