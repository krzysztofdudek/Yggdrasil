---
id: go-external-test-package-edge
language: go
category: import
expectation: edge
cites: "pkg.go.dev/cmd/go — Test packages (a `package x_test` file in the package directory is compiled as a separate package that imports others by path)"
---

## Rule

An external test file (`m/billing/billing_test.go`, `package billing_test`) sits in the package directory but is its own package, and it imports other packages by path like any file. Its `import "example.com/m/orders"` binds `m/orders/orders.go` (node `orders`). The `_test` package clause changes nothing about how the import resolves.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/orders/orders.go
package orders
func Place() {}
```

```go path=m/billing/billing_test.go
package billing_test
import "example.com/m/orders"
func TestX() { orders.Place() }
```

## Expect

- m/billing/billing_test.go:2 -> node:orders      # an external test package imports by path like any file

## Why

Test code's dependencies are real code dependencies and cross the same node boundaries.
