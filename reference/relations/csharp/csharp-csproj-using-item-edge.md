---
id: csharp-csproj-using-item-edge
language: csharp
category: import
expectation: edge
cites: "MSBuild — the Using item (`<Using Include=N />`) generates a global using for the project; MS Learn — C# project properties, ImplicitUsings"
---

## Rule

A `<Using Include="N" />` item in a project's `.csproj` (or in the nearest `Directory.Build.props` / `Directory.Build.targets`) is a `global using N;` the SDK generates for that project. A bare name in any file of the project therefore acquires the `N.` candidate. `<Using Include="N" Alias="A" />` is a global alias, `Static="true"` a static import (not a namespace), and `<Using Remove="N" />` removes an earlier item.

## Files

```xml path=src/web/Web.csproj
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <Using Include="Shop.Domain" />
  </ItemGroup>
</Project>
```

```csharp path=src/web/Page.cs
namespace Web;
public class Page { Order _order; }
```

```csharp path=src/domain/Order.cs
namespace Shop.Domain;
public class Order {}
```

## Expect

- src/web/Page.cs:2 -> node:domain      # `Order` qualifies through the project's `<Using Include="Shop.Domain" />`

## Why

Many .NET solutions declare their global usings in the project file instead of a `GlobalUsings.cs`. A tool that reads only sources misses every dependency those imports carry.
