---
id: csharp-di-reflection-extension-silence
language: csharp
category: dynamic
expectation: silence
cites: "C# — runtime DI resolution and reflection strings (no static type reference); MS Learn — dependency injection, Type.GetType"
---

## Rule

Dependency-injection registration resolved at runtime (`services.AddScoped<IFoo, Foo>()`
where neither type is declared in the graph) and a reflection string
(`Type.GetType("MyApp.Pay.Gateway")`) are not statically resolvable type references. A
type named ONLY inside a reflection string is not a real static dependency, so no
cross-node edge may be emitted — even when that type exists in the graph. An extension
method call on a value (`order.Validate()`) binds at compile time and is resolved when an
in-repo extension of that name is in scope (csharp-extension-via-owned-namespace); here
none is declared, so it resolves to nothing.

## Files

```csharp path=src/c/Use.cs
using Microsoft.Extensions.DependencyInjection;
class Startup {
  void Configure(IServiceCollection services) { services.AddScoped<IFoo, Foo>(); }
  void R() { var t = System.Type.GetType("MyApp.Pay.Gateway"); }
  void E(object order) { order.Validate(); }
}
```

```csharp path=src/pay/Gateway.cs
namespace MyApp.Pay;
public class Gateway {}
```

## Expect

- silence      # `MyApp.Pay.Gateway` appears only as a reflection STRING → not a static dependency → no edge

## Why

Reflection strings and runtime DI resolution are dynamic: the compiler never sees the
dependency, so treating them as static references would invent edges. Extension methods
are different — C# binds them statically — which is why they have their own edge case
rather than a place in this silence.
