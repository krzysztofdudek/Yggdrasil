---
id: go-major-version-module-edge
language: go
category: import
expectation: edge
cites: "go.dev/ref/mod — Major version suffixes (module example.com/m/v2 lives in the repository root; the /v2 is part of the module path, not a directory)"
---

## Rule

A v2+ module declares a major-version suffix in its module path (`module example.com/m/v2`) while its packages stay where they are on disk. `example.com/m/v2/billing` strips the full module path, `/v2` included, to `billing` and binds `m/billing/billing.go` (node `billing`); no `v2/` directory is expected.

## Files

```go path=m/go.mod
module example.com/m/v2
```

```go path=m/billing/billing.go
package billing
func Charge() {}
```

```go path=m/app/main.go
package main
import "example.com/m/v2/billing"
func main() { billing.Charge() }
```

## Expect

- m/app/main.go:2 -> node:billing      # the /v2 suffix is part of the module path → remainder billing → m/billing/

## Why

The major-version suffix is the documented v2+ layout; treating it as a directory would miss every in-module import.
