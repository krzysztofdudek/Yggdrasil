---
id: csharp-generic-arity-split-files-edge
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §7.8 (type arity is part of a type's identity); §8.4 (constructed types)"
---

## Rule

`Result` and `Result<T>` are different types that share a simple name, and projects often keep them in separate files. Declaration keys carry no arity, so both files declare one key. When both files belong to the same node, `Result` and `Result<int>` are dependencies on that node.

## Files

```csharp path=src/app/Uses.cs
using Shop.Results;
class Uses {
  Result _r;
  Result<int> _ri;
}
```

```csharp path=src/res/Result.cs
namespace Shop.Results;
public class Result {}
```

```csharp path=src/res/ResultOfT.cs
namespace Shop.Results;
public class Result<T> : Result {}
```

## Expect

- src/app/Uses.cs:3 -> node:res      # non-generic Result
- src/app/Uses.cs:4 -> node:res      # generic Result<int>; both files are node res

## Why

The `Result`/`Result<T>`, `Entity`/`Entity<TId>` and `IRequest`/`IRequest<T>` pairs are the core of many shared kernels. Counting files silenced both references.
