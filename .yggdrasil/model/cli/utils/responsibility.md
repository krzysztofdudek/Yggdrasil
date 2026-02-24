# Utils Responsibility

Shared helper functions used by CLI modules. Primitive operations — no domain logic.

**In scope:**

- **paths.ts:** findYggRoot (searches upward for .yggdrasil), normalizeMappingPaths (NodeMapping to string[]), normalizeProjectRelativePath (POSIX, throws if outside root), getPackageRoot (via import.meta.url), toGraphPath (absolute to model-relative)
- **hash.ts:** hashFile (SHA-256), hashString, hashPath (file or directory, respects .gitignore), perFileHashes (per-file for diagnostics), hashForMapping (drift hash, throws if no paths)
- **tokens.ts:** estimateTokens — Math.ceil(text.length/4) heuristic
- **git.ts:** getLastCommitTimestamp — git log -1 --format=%ct, returns null on error

**Out of scope:**

- Business logic (cli/core, cli/commands)
- Parsing (cli/io)
