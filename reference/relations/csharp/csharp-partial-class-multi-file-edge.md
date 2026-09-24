---
id: csharp-partial-class-multi-file-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §15.2.7 (partial type declarations); MS Learn — partial classes and methods"
---

## Rule

A `partial` type declared across several files is ONE type. When every file that declares it belongs to the same node, a reference to it is a dependency on that node. The resolver counts ambiguity by owner NODE, not by file.

## Files

```csharp path=src/app/Uses.cs
using Shop.People;
class Uses { Customer _c; }
```

```csharp path=src/people/Customer.cs
namespace Shop.People;
public partial class Customer {}
```

```csharp path=src/people/Customer.Validation.cs
namespace Shop.People;
public partial class Customer { void Validate() {} }
```

## Expect

- src/app/Uses.cs:2 -> node:people      # both declaring files are node people → one target

## Why

Counting files silenced every partial class: designer files, source generators, and large types split by concern. The target was never ambiguous. csharp-partial-class-split-across-nodes-silence keeps the cross-node split silent.
