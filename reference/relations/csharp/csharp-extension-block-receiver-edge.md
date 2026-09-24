---
id: csharp-extension-block-receiver-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# 14 — extension members (extension blocks, receiver parameter); MS Learn — what's new in C# 14"
---

## Rule

A C# 14 `extension(Order order) { … }` block names its receiver type, and the members inside it name their own types. Both are type references. A C# 14 grammar parses the receiver as a `receiver_parameter` under an `extension_declaration`. The shipped pre-C# 14 grammar misreads the block as a constructor named `extension`, with the receiver as an ordinary parameter and the members as local functions. The extractor reads both shapes, so the edge does not depend on the misreading. The test also asserts that the parse is one of these two shapes.

## Files

```csharp path=src/app/OrderExtensions.cs
using Shop.Domain;
using Shop.Pricing;
public static class OrderExtensions {
  extension(Order order) {
    public Money Total() => default;
  }
}
```

```csharp path=src/domain/Order.cs
namespace Shop.Domain;
public class Order {}
```

```csharp path=src/pricing/Money.cs
namespace Shop.Pricing;
public class Money {}
```

## Expect

- src/app/OrderExtensions.cs:4 -> node:domain      # receiver type of the extension block
- src/app/OrderExtensions.cs:5 -> node:pricing     # return type of a member inside the block

## Why

csharp-extension-receiver-type already pinned the receiver edge, but only through the misreading. When the grammar is upgraded that shape disappears. The `receiver_parameter` reading and the shape assertion keep the edge, and make a third shape fail the test.
