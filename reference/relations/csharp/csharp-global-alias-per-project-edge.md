---
id: csharp-global-alias-per-project-edge
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (global using alias directives apply to their own project); MSBuild — one .csproj is one compilation"
---

## Rule

A global alias applies to the project that declares it. Two projects may each define `global using Money = …;` with different targets, and each file binds its own project's alias.

## Files

```xml path=src/billing/Billing.csproj
<Project Sdk="Microsoft.NET.Sdk"></Project>
```

```csharp path=src/billing/GlobalUsings.cs
global using Money = Billing.Model.Money;
```

```csharp path=src/billing/Invoice.cs
namespace Billing;
public class Invoice { Money _total; }
```

```xml path=src/shipping/Shipping.csproj
<Project Sdk="Microsoft.NET.Sdk"></Project>
```

```csharp path=src/shipping/GlobalUsings.cs
global using Money = Shipping.Model.Money;
```

```csharp path=src/shipping/Parcel.cs
namespace Shipping;
public class Parcel { Money _fee; }
```

```csharp path=src/bmodel/Money.cs
namespace Billing.Model;
public class Money {}
```

```csharp path=src/smodel/Money.cs
namespace Shipping.Model;
public class Money {}
```

## Expect

- src/billing/Invoice.cs:2 -> node:bmodel      # Billing's own alias → Billing.Model.Money
- src/shipping/Parcel.cs:2 -> node:smodel      # Shipping's own alias → Shipping.Model.Money

## Why

Before project scoping, one alias overwrote the other, so one of these two edges pointed at the wrong node.
