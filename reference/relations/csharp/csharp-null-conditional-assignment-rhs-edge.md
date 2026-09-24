---
id: csharp-null-conditional-assignment-rhs-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# 14 — null-conditional assignment (`a?.B = value`); MS Learn — what's new in C# 14"
---

## Rule

In a C# 14 null-conditional assignment `h?.Last = new Order();`, the right-hand side is an ordinary expression, and `new Order()` depends on `Order`. The shipped pre-C# 14 grammar recovers the statement as `h?.<ERROR Last = new> Order()`. The extractor reads that recovery shape (a member binding with an ERROR child ending in `new`) as the object creation it is. A grammar that knows the form produces a plain object creation, which is already covered.

## Files

```csharp path=src/app/Svc.cs
using Shop.Domain;
class Svc {
  void F(Holder? h) { h?.Last = new Order(); }
}
class Holder { public object? Last { get; set; } }
```

```csharp path=src/domain/Order.cs
namespace Shop.Domain;
public class Order {}
```

## Expect

- src/app/Svc.cs:3 -> node:domain      # `new Order()` on the right of a null-conditional assignment

## Why

The shipped grammar drops the object creation from the tree for this form, so the dependency disappeared. Only the plain `new T()` recovery is read; richer right-hand sides wait for the grammar upgrade.
