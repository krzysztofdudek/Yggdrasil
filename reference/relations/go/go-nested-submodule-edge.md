---
id: go-nested-submodule-edge
language: go
category: import
expectation: edge
cites: "go.dev/ref/mod — Modules (a nested go.mod starts a new module rooted at its own directory)"
---

## Rule

A package of a nested module is rooted under the nested module's directory, not the repository root. From `m/security/advancedtls/tls.go` (nearest go.mod: `module example.com/m/security/advancedtls`), `example.com/m/security/advancedtls/internal/testutils` strips the nested module path to `internal/testutils` and joins it onto `m/security/advancedtls`, binding `m/security/advancedtls/internal/testutils/util.go` (node `testutils`).

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/security/advancedtls/go.mod
module example.com/m/security/advancedtls
```

```go path=m/security/advancedtls/internal/testutils/util.go
package testutils
func Load() {}
```

```go path=m/security/advancedtls/tls.go
package advancedtls
import "example.com/m/security/advancedtls/internal/testutils"
func f() { testutils.Load() }
```

## Expect

- m/security/advancedtls/tls.go:2 -> node:testutils      # nested module path stripped, remainder joined onto the nested module's own directory

## Why

Rooting the remainder at the repository root would bind a same-named package of the parent module, a wrong target. The resolver-level test for the same-leaf decoy lives beside go-resolve's unit tests, since this catalogue names nodes by directory basename.
