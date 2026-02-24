# Utils Logic

## hash.ts

### hashFile

- readFile, createHash('sha256').update(content).digest('hex')

### hashPath (file or directory)

- **File**: if isIgnoredPath → hashString(''); else hashFile
- **Directory**: collectDirectoryFileHashes (recursive, respect .gitignore); sort by path; digest = sorted "path:hash" pairs joined by newline; hashString(digest)

### hashForMapping (drift hash)

- paths from mapping.paths; empty → throw "Invalid mapping for hash: no paths"
- For each path: if file → hashFile; if directory → hashPath (with projectRoot for .gitignore)
- pairs sorted by path; digest = "path:hash" joined; SHA-256 of digest

### perFileHashes

- For each path: if file → { path, hash }; if directory → collectDirectoryFileHashes, prefix paths with mapping path
- Returns flat list; used for diagnoseChangedFiles

### collectDirectoryFileHashes

- readdir; for each entry: if ignored → skip; if dir → recurse; if file → hashFile, path relative to root
- .gitignore loaded from projectRoot; isIgnoredPath checks relative path

### isIgnoredPath

- relativePath = path.relative(projectRoot, candidatePath); if '' or startsWith('..') → false
- matcher.ignores(relativePath) || matcher.ignores(relativePath + '/')
