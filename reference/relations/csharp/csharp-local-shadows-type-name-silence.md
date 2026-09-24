---
id: csharp-local-shadows-type-name-silence
language: csharp
category: trap
expectation: silence
cites: "C# spec §12.8.4 (simple names — locals, parameters and members are found before types); §7.7 (scopes and hiding)"
---

## Rule

A simple name binds a local, parameter or member before a type. `Guard.ToString()` on a field named `Guard` is an instance call, not a use of the type `Guard`. A member-access receiver is read as a type only when the file declares no value or member of that name. The check covers the whole file, so it can only drop a reading and never add one.

## Files

```csharp path=src/app/Uses.cs
using Shop.Core;
class Uses {
  object Guard;
  void F(object o) { var OrderStatus = o; OrderStatus.ToString(); Guard.ToString(); }
  void G(object Clock) { Clock.ToString(); }
}
```

```csharp path=src/core/Types.cs
namespace Shop.Core;
public static class Guard {}
public enum OrderStatus { New }
public class Clock {}
```

## Expect

- silence      # field Guard, local OrderStatus and parameter Clock shadow the same-named types → no edge

## Why

Without this guard, reading member-access receivers as types would turn every value named like a type into a false edge. One gap remains: a member inherited from a base class declared in another file, or declared in another part of a partial class, is not visible to this per-file guard. If such a member shares its name with a type that is in scope in another node, the receiver is still read as that type.
