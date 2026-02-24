# Drift Detector Logic

## detectDrift

For each mapped node (or single node if filterNodePath):

1. **No stored entry** (.drift-state has no entry for nodePath):
   - `allPathsMissing(projectRoot, mappingPaths)` — access() each path; returns true only when ALL paths missing
   - If all missing → status `unmaterialized`, details "No drift state recorded, files do not exist"
   - If any exist → status `drift`, details "No drift state recorded, files exist (run drift-sync after materialization)"

2. **Stored entry exists**:
   - Get storedHash via getCanonicalHash(storedEntry)
   - Try: currentHash = hashForMapping(projectRoot, mapping)
   - If hash mismatch → status `drift`, details = diagnoseChangedFiles (per-file diff) or "File(s) modified since last sync"
   - If hashForMapping throws (paths don't exist) → status `missing`, details "Mapped path(s) do not exist"
   - If hash matches → status `ok`

## diagnoseChangedFiles

- perFileHashes(projectRoot, mapping) → current
- If no storedFileHashes → return all current paths (sorted)
- Else: compare each current hash to stored; add to changed if different or missing
- Add deleted paths (in stored but not in current) with " (deleted)" suffix
- Return sorted list

## allPathsMissing

- For each mappingPath: access(absPath). If any succeeds → return false
- Return true only when all paths fail (ENOENT)

## syncDriftState

- Compute currentHash via hashForMapping
- Per-file hashes via perFileHashes → build files Record
- Write { hash, files } to .drift-state for nodePath
- Return { previousHash?, currentHash }
