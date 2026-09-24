---
id: csharp-generic-base-class-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §8.4 (constructed types); §15.2.4 (class base specification)"
---

## Rule

In a constructed type `Repository<Order>`, the generic type `Repository` is a type reference, just as the argument `Order` is. The base name resolves like a bare identifier, and a qualified generic `Shop.Core.Repository<int>` resolves by its plain dotted name.

## Files

```csharp path=src/app/OrderRepo.cs
using Shop.Core;
using Shop.Domain;
public class OrderRepo : Repository<Order> {
  Shop.Core.Repository<int> _qualified;
}
```

```csharp path=src/core/Repository.cs
namespace Shop.Core;
public abstract class Repository<T> {}
```

```csharp path=src/domain/Order.cs
namespace Shop.Domain;
public class Order {}
```

## Expect

- src/app/OrderRepo.cs:3 -> node:core      # generic base class `Repository<…>`
- src/app/OrderRepo.cs:3 -> node:domain    # its type argument `Order`
- src/app/OrderRepo.cs:4 -> node:core      # qualified generic field type

## Why

Repositories, `Entity<TId>` and `AggregateRoot<TId>` are often the only thing a node uses from its shared kernel. Skipping the generic base name hid all of them.
