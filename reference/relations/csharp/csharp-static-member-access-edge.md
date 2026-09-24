---
id: csharp-static-member-access-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §12.8.7 (member access through a type name); §7.6 (namespace and type names)"
---

## Rule

In a member access `Guard.NotNull(o)`, the receiver `Guard` is a simple name. When no local, parameter or member of that name is in scope, it names a TYPE, and the access is a dependency on that type. A fully qualified receiver `Shop.Core.Guard.NotNull(o)` binds the same type: C# reads the leftmost name first and continues through the namespaces.

## Files

```csharp path=src/app/Uses.cs
using Shop.Core;
class Uses {
  void F(object o) { Guard.NotNull(o); }
  void G(object o) { Shop.Core.Guard.NotNull(o); }
}
```

```csharp path=src/core/Guard.cs
namespace Shop.Core;
public static class Guard { public static void NotNull(object o) {} }
```

## Expect

- src/app/Uses.cs:3 -> node:core      # static call through the imported type name
- src/app/Uses.cs:4 -> node:core      # static call through the fully qualified type name

## Why

Guard, helper and constant classes and factory methods (`Result.Success()`) are often a node's only use of a shared kernel. They appear only as member-access receivers. csharp-local-shadows-type-name-silence covers the other side: a value that shadows the type name gives no edge.
