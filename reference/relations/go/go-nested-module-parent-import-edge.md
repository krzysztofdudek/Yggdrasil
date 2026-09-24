---
id: go-nested-module-parent-import-edge
language: go
category: import
expectation: edge
cites: "go.dev/ref/mod — Modules, packages, and versions (a package belongs to the module with the longest matching module path); the grpc-go layout (security/advancedtls is a nested module importing its parent)"
---

## Rule

A nested module (`m/security/advancedtls/go.mod`, `module example.com/m/security/advancedtls`) that imports a package of its parent module (`example.com/m/credentials`) names a package that lives in the same repository. The resolver indexes every go.mod on the path from the importing file up to the repository root and resolves the import against the LONGEST module path that prefixes it. `example.com/m/credentials` does not start with the nested module's path but does start with the parent's `example.com/m`, so it binds `m/credentials/creds.go` (node `credentials`). A directory that a deeper go.mod claims for another module is never reached through the parent's path.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/security/advancedtls/go.mod
module example.com/m/security/advancedtls

require example.com/m v1.0.0

replace example.com/m => ../../
```

```go path=m/credentials/creds.go
package credentials
type Bundle struct{}
```

```go path=m/security/advancedtls/tls.go
package advancedtls
import "example.com/m/credentials"
var _ credentials.Bundle
```

## Expect

- m/security/advancedtls/tls.go:2 -> node:credentials      # the parent module example.com/m is the longest matching in-repo module → m/credentials/

## Why

Nested modules that import their parent (grpc-go's submodules, Kubernetes staging) are common. Module paths are unique, so the longest in-repo match names exactly one directory.
