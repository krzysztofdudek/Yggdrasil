# Utils Errors

- **findYggRoot:** Throws if .yggdrasil not found ("Run yg init first") or exists but is not a directory. ENOENT triggers upward search; rethrows other errors.
- **normalizeProjectRelativePath:** Throws if path empty or outside project root.
- **hashForMapping:** Throws "Invalid mapping for hash: no paths" if mapping.paths empty or undefined.
- **hashFile, hashPath, perFileHashes:** Propagate ENOENT, EACCES from readFile/readdir/stat.
- **getLastCommitTimestamp:** Returns null on git errors (not a repo, path has no commits); does not throw.
