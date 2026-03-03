# Owner Command Logic

## Path normalization

1. The input `--file` path is normalized to a project-relative, forward-slash path via `normalizeProjectRelativePath` (resolves absolute paths, strips trailing slashes, normalizes separators).
2. The normalized path is further cleaned by `normalizeForMatch`: backslashes replaced with forward slashes, trailing slashes removed.

## Mapping comparison algorithm

1. Iterate all graph nodes and their normalized mapping paths.
2. **Exact match:** If the file path equals a mapping path exactly, return immediately with that node as owner.
3. **Prefix match (longest wins):** If the file path starts with a mapping path followed by `/`, record it as a candidate. Among all prefix matches, the one with the longest mapping path wins (most specific owner).
4. If no match found, return `{ nodePath: null }` indicating no graph coverage.

## File existence check

Before reporting "no graph coverage," the command checks if the file actually exists on disk (`fs.access`). If it does not exist, the output includes a `(file not found)` hint to distinguish from files that exist but lack graph coverage.

The algorithm guarantees that deeper (more specific) mappings take precedence over broader ones, and exact matches always win over prefix matches.
