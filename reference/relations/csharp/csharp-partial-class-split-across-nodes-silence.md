---
id: csharp-partial-class-split-across-nodes-silence
language: csharp
category: trap
expectation: silence
cites: "C# spec §15.2.7 (partial type declarations)"
---

## Rule

When the files declaring one type belong to two or more nodes, a reference to the type cannot name a single target node. It stays silent.

## Files

```csharp path=src/app/Uses.cs
using Shop.People;
class Uses { Customer _c; }
```

```csharp path=src/people/Customer.cs
namespace Shop.People;
public partial class Customer {}
```

```csharp path=src/generated/Customer.g.cs
namespace Shop.People;
public partial class Customer { void Map() {} }
```

## Expect

- silence      # declarations in nodes people and generated → no single owner → no edge

## Why

Picking either node would report a dependency the code does not single out. Zero false positives outrank the recall.
