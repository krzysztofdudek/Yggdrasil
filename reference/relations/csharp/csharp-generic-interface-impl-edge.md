---
id: csharp-generic-interface-impl-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §8.4 (constructed types); §18.2.4 (interface implementations); §12.8.18 (typeof with unbound generic)"
---

## Rule

Implementing a constructed generic interface `IHandler<string, int>` depends on the interface `IHandler`. An unbound generic `typeof(IHandler<,>)` names the same type.

## Files

```csharp path=src/app/PlaceOrder.cs
using Shop.Core;
public class PlaceOrderHandler : IHandler<string, int> {}
public class Registry { System.Type _t = typeof(IHandler<,>); }
```

```csharp path=src/core/IHandler.cs
namespace Shop.Core;
public interface IHandler<TRequest, TResponse> {}
```

## Expect

- src/app/PlaceOrder.cs:2 -> node:core      # implemented generic interface
- src/app/PlaceOrder.cs:3 -> node:core      # unbound generic in typeof

## Why

Mediator-style handlers (`IRequestHandler<TReq, TRes>`) and validators (`IValidator<T>`) are generic interfaces. Their only dependency sits in the generic base name.
