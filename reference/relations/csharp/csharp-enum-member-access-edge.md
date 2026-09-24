---
id: csharp-enum-member-access-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §12.8.7 (member access); §19 (enums)"
---

## Rule

An enum member `OrderStatus.Paid` is a member access through the enum's type name. The enum is a dependency, including in a `case` label.

## Files

```csharp path=src/app/Uses.cs
using Shop.Core;
class Uses {
  object _s = OrderStatus.Paid;
  bool IsNew(object o) { switch (o) { case OrderStatus.New: return true; default: return false; } }
}
```

```csharp path=src/core/OrderStatus.cs
namespace Shop.Core;
public enum OrderStatus { New, Paid }
```

## Expect

- src/app/Uses.cs:3 -> node:core      # enum member in an initializer
- src/app/Uses.cs:4 -> node:core      # enum member in a case label

## Why

Many files use an enum only through its members and never declare a variable of the enum type.
