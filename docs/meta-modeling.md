# Meta-modeling

Most of your graph models your **application** — its components, the rules they must
satisfy, the relations between them. Meta-modeling turns the same machinery on the
graph's OWN rule files: the deterministic checks, rule documents, and definitions
under the `.yggdrasil/` directory. Map them into the graph and you can verify the
rules the way you verify everything else — the rules reviewing the rules.

The motivating shape is a feedback loop: a requirements document names the check
meant to enforce it, and a rule reads that check and judges whether it actually does
what the requirement says.

## It's allowed, and opt-in

Pointing a component's file mapping at a path under `.yggdrasil/` is allowed — the
graph directory is no more restricted than the rest of your code. (The usual
mapping rules still apply everywhere: a mapped path may not be absolute or climb
above the repo root, it must exist on disk, and it can't overlap another
component's mapping.) And because the graph directory is excluded from the
"uncovered files" scan, you can model a few rule files without the coverage check
demanding you model the rest. Meta-modeling is partial by design.

## Four ways a rule file reaches a reviewer

1. **Mapping** — map the file to a component and it becomes a reviewed file there.
2. **Static reference** — list it under a rule's `references:` and its contents ride
   every prompt for that rule. References need no mapping and no relation.
3. **Companion (per unit)** — a `companion.mjs` hook returns a different file per
   unit, so each requirement document can pull in the specific check it names. A
   companion-returned file must be reachable from the reviewed component (its own
   files, a declared relation's target, an ancestor, or a descendant).
4. **Deterministic read** — a deterministic check may read a reachable rule file
   through its context object (same reachability rule as a companion).

References (2) need no graph wiring; companion (3) and deterministic reads (4) need
the target reachable, which for a graph-directory file means mapping it and declaring
a relation to its component.

## Consequences — read before you map

Mapping rule files makes them first-class citizens, with the obligations that brings:

- The built-in relation check parses your mapped check code; a check that imports
  another component's code needs that relation declared, or it's refused.
- Every rule effective on the component now reviews those rule files too — choose the
  component's type deliberately and use [conditional rules](/conditional-aspects) so a
  code rule doesn't fire on a Markdown rule file.
- The file-classification predicate auto-exempts every `.yggdrasil/` path — it returns
  true without checking — so you can map a rule file to a component of any type without
  tripping a type/`when` mismatch. The flip side: the type's `when` gives you no
  filtering here. It is the aspect's own scope, not the type predicate, that decides
  whether a given rule actually fires on a mapped rule file.
- A rule that reviews another rule means editing one re-checks both — keep the meta
  layer small and targeted.
- **Never map the whole `.yggdrasil/` directory.** A broad glob would sweep in the
  committed verdict lock, which changes on every approval and would never settle. Map
  narrowly — name the specific rule files you mean.

## Keeping the blast radius small

Map narrowly; attach the meta rule on the narrowest component that owns the files it
judges, not a broad parent that would cascade everywhere; and use
[conditional rules](/conditional-aspects) to target exactly the units you mean. Rule
ids can be nested in directories, so a meta layer can live under its own prefix and
stay legible — see [Aspects](/aspects).
