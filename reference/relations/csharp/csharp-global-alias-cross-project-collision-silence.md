---
id: csharp-global-alias-cross-project-collision-silence
language: csharp
category: trap
expectation: silence
cites: "C# spec §13.4 (global using alias directives are project-wide); CS1537 (duplicate alias within one compilation)"
---

## Rule

When the pass cannot tell projects apart (no `.csproj` in the tree, so every file shares one implicit project) and two files define the same global alias name with different targets, the alias has no single binding. Every reference led by that alias stays silent. Neither target is picked.

## Files

```csharp path=src/billing/GlobalUsings.cs
global using Money = Billing.Model.Money;
```

```csharp path=src/shipping/GlobalUsings.cs
global using Money = Shipping.Model.Money;
```

```csharp path=src/billing/Invoice.cs
namespace Billing;
public class Invoice { Money _total; }
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

- silence      # `Money` has two project-wide alias targets → ambiguous → no edge (never last-writer-wins)

## Why

Last-writer-wins bound Billing's `Money` to `Shipping.Model.Money` (node smodel), a wrong target that depended on file order. Inside one real project the duplicate alias is a compile error, so in practice the collision means two projects the tool could not separate. Silence is the only answer that cannot be wrong. With project files present, csharp-global-alias-per-project-edge binds each project's own alias.
