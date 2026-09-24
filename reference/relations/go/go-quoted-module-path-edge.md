---
id: go-quoted-module-path-edge
language: go
category: import
expectation: edge
cites: "go.dev/ref/mod — go.mod files, module directive (the module path may be an interpreted or raw string: `module \"example.com/m\"`)"
---

## Rule

The go.mod grammar accepts the module path as a quoted string: `module "example.com/m"` means the same as `module example.com/m`. The resolver unquotes the path (double quotes or backticks) and strips a trailing `//` comment before using it as the module prefix, so `example.com/m/billing` binds `m/billing/billing.go` (node `billing`).

## Files

```go path=m/go.mod
module "example.com/m" // quoted form

go 1.22
```

```go path=m/billing/billing.go
package billing
func Charge() {}
```

```go path=m/app/main.go
package main
import "example.com/m/billing"
func main() { billing.Charge() }
```

## Expect

- m/app/main.go:2 -> node:billing      # the unquoted module path example.com/m is the prefix → m/billing/

## Why

Keeping the quotes in the module path makes every import in the module look external, which silently disables resolution for the whole module.
