---
id: csharp-generic-external-container-silence
language: csharp
category: builtin
expectation: silence
cites: "C# spec §8.4 (constructed types); §7.6 (namespace and type names — lookup through the enclosing namespaces and using directives)"
---

## Rule

The base name of a BCL generic container (`List<int>`, `Task<string>`, `Dictionary<string, int>`) resolves to no in-graph declaration and stays silent. An in-repo type with the same simple name in a namespace that is not in scope is never a candidate.

## Files

```csharp path=src/c/Use.cs
using System.Collections.Generic;
using System.Threading.Tasks;
namespace App;
class C { List<int> _xs; Task<string> _t; Dictionary<string, int> _d; }
```

```csharp path=src/other/List.cs
namespace Other.Collections;
public class List {}
```

```csharp path=src/other/Task.cs
namespace Other.Work;
public class Task {}
```

## Expect

- silence      # List/Task/Dictionary bind the BCL; Other.Collections.List and Other.Work.Task are not in scope

## Why

Emitting the generic base name is safe because a candidate binds only through the names in scope. External containers resolve to nothing, which the resolver treats as silence.
