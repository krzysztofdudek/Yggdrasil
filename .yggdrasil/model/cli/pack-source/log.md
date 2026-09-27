## [2026-09-27T01:13:00.519Z]
No longer touches the file system itself: the two probes of a local source (a directory here, a marketplace manifest at its root) moved into the package store. What remains is the command-layer part of installing a package: reading the spec, resolving and recording a source, the fetch session and the refusals the pack commands print.
