# variants/type-only

Carries no files of its own beyond this README. A consuming test must EMPTY
the temp copy's `.yggdrasil/model/` directory (delete every child, but leave
the directory itself in place — `loadGraph` throws if `model/` does not exist
at all) before loading, so the resulting project has zero explicit
components — the base fixture's `yg-architecture.yaml` already attaches
`own-file-rule` only to `leaf`, so no architecture override is needed here.
Pins that a rule live only on files, with no component anywhere in the graph,
is not dead law.
