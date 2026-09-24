---
id: csharp-extension-via-owned-namespace
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §12.8.10.3 (extension method invocations — bound at compile time through the namespaces in scope); MS Learn — extension methods"
---

## Rule

An extension-method call `builder.Services.AddInfrastructure()` binds at COMPILE TIME. C# looks the method name up among the extension methods of the enclosing namespaces and the imported namespaces. Extension methods are indexed by namespace and name (`Shop.Infrastructure.AddInfrastructure()`), and a call on a value receiver resolves through the same scopes. One declaring node gives an edge. Two or more nodes declaring an in-scope method of that name give silence. Calls to `System.Object` members, and to a name the calling file itself declares as a method, are never read as extension calls, because an instance method wins.

## Files

```csharp path=src/web/Program.cs
using Shop.Infrastructure;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddInfrastructure();
```

```csharp path=src/infra/DependencyInjection.cs
namespace Shop.Infrastructure;
public static class DependencyInjection {
  public static IServiceCollection AddInfrastructure(this IServiceCollection services) => services;
}
```

## Expect

- src/web/Program.cs:3 -> node:infra      # extension method from the imported Shop.Infrastructure

## Why

This is the composition-root dependency of Clean Architecture .NET code (`AddApplication()`, `AddInfrastructure()`), the edge an architecture gate most needs to see. An earlier version of the palette called extension dispatch dynamic. It is not dynamic. One risk remains: an external receiver type with an instance method of the same name as an in-repo extension method in scope. The instance method wins in C#, but the tool cannot see the receiver's type.
