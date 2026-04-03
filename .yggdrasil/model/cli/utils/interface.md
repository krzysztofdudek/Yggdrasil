# Utils Interface

Public API consumed by cli/core and cli/commands.

## paths.ts

- `findYggRoot(projectRoot: string): Promise<string>` — searches upward for .yggdrasil/; throws if not found ("Run yg init first") or exists but not a directory
- `normalizeMappingPaths(mapping: NodeMapping | undefined): string[]` — returns trimmed paths from all mapping groups (MappingGroup[]); collects paths from all groups into flat array; empty array if no groups or empty paths
- `normalizeProjectRelativePath(projectRoot: string, rawPath: string): string` — normalizes to project-relative POSIX; throws if empty or outside project root
- `getPackageRoot(): string` — directory containing CLI package (dist/ when bundled), via fileURLToPath(import.meta.url)
- `toGraphPath(absolutePath: string, yggRoot: string): string` — path.relative then replace sep with /

## hash.ts

- `hashFile(filePath: string): Promise<string>` — SHA-256 hex of file content
- `hashString(content: string): string` — SHA-256 hex of string
- `hashPath(targetPath: string, options?: { projectRoot?: string }): Promise<string>` — file: hashFile; directory: sorted path:hash digest. Respects hierarchical .gitignore (root + nested)
- `perFileHashes(projectRoot: string, mapping: { paths?: string[] }): Promise<Array<{ path: string; hash: string }>>` — returns [] for empty paths; respects hierarchical .gitignore
- `hashForMapping(projectRoot: string, mapping: { paths?: string[] }): Promise<string>` — drift hash; throws "Invalid mapping for hash: no paths" if no paths
- `hashTrackedFiles(projectRoot: string, trackedFiles: TrackedFile[]): Promise<{ canonicalHash: string; fileHashes: Record<string, string> }>` — drift detection hash; expands directories with hierarchical .gitignore filtering

## tokens.ts

- `estimateTokens(text: string): number` — Math.ceil(text.length / 4)

## git.ts

- `getLastCommitTimestamp(projectRoot: string, relativePath: string): number | null` — git log -1 --format=%ct; null if not git repo or path has no commits

## Failure Modes

- **findYggRoot:** Throws if .yggdrasil not found ("Run yg init first") or exists but is not a directory. ENOENT triggers upward search; rethrows other errors.
- **normalizeProjectRelativePath:** Throws if path empty or outside project root.
- **hashForMapping:** Throws "Invalid mapping for hash: no paths" if mapping.paths empty or undefined.
- **hashFile, hashPath, perFileHashes:** Propagate ENOENT, EACCES from readFile/readdir/stat.
- **getLastCommitTimestamp:** Returns null on git errors (not a repo, path has no commits); does not throw.
