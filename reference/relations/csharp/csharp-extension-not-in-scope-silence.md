---
id: csharp-extension-not-in-scope-silence
language: csharp
category: trap
expectation: silence
cites: "C# spec §12.8.10.3 (extension method invocations — only namespaces in scope are searched)"
---

## Rule

An extension method is a candidate only when its namespace is in scope (enclosing or imported). An extension of the same name in a namespace the file neither encloses nor imports cannot be the one the call binds to.

## Files

```csharp path=src/web/Program.cs
using Shop.Application;
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

- silence      # Shop.Infrastructure is not imported → its AddInfrastructure is not a candidate

## Why

Matching extension methods by name alone would bind any same-named extension anywhere in the repository. The namespace scope is what makes the binding the compiler's.
