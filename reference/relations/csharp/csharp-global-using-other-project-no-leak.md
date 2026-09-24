---
id: csharp-global-using-other-project-no-leak
language: csharp
category: trap
expectation: silence
cites: "C# spec §13.4 (global using directives apply to the compilation unit's project); MSBuild — one .csproj is one compilation"
---

## Rule

A `global using N;` imports `N` into every file of the PROJECT that declares it, and into no other project. The project of a file is the nearest ancestor directory holding a `*.csproj`. A file of another project never sees the directive, so a bare name there must not acquire the `N.` candidate.

## Files

```xml path=src/api/Api.csproj
<Project Sdk="Microsoft.NET.Sdk"></Project>
```

```csharp path=src/api/GlobalUsings.cs
global using Api.Models;
```

```csharp path=src/api/models/Customer.cs
namespace Api.Models;
public class Customer {}
```

```xml path=src/worker/Worker.csproj
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup><PackageReference Include="Vendor.Crm" Version="1.0.0" /></ItemGroup>
</Project>
```

```csharp path=src/worker/SyncJob.cs
using Vendor.Crm;
namespace Worker;
public class SyncJob { Customer _c; }
```

## Expect

- silence      # Worker's `Customer` comes from the external Vendor.Crm package; Api's global using never reaches the Worker project

## Why

Aggregating global usings repo-wide made the Worker file bind `Api.Models.Customer` (node models), a false edge that blocked CI. Scoping global usings to the declaring project removes it. The case is a silence because Worker's real binding is to an external package the tool cannot see.
