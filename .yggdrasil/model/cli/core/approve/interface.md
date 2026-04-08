# Approve Interface

**`approveNode(graph, nodePath, options?): Promise<ApproveResult>`** — three-axis change detection + baseline recording.

`options.reviewed?: string` — bypasses three-axis gate with a reason.

**`ApproveResult`** — discriminated by `action`:

- `'approved'` — both artifacts and source changed. Fields: `previousHash`, `currentHash`, `gcPaths`.
- `'reviewed'` — `--reviewed` bypassed gate. Fields: `previousHash`, `currentHash`, `isBlackbox`, `gcPaths`.
- `'initial'` — first approve for this node. Fields: `currentHash`, `gcPaths`.
- `'no-change'` — baseline already current. Fields: `currentHash`.
- `'refused'` — gate failed. Fields: `refuseReason`, `axes` (ownArtifacts/source/otherTracked as changed/unchanged), `changedOwnArtifacts`, `changedSource`, `changedOther`, `blackboxBlocked`, `antiLaunderingBlocked`, `conflictingFiles`, `reviewedAttempted`.

**Exported helpers:**

- `resolveAspects(node, graph): Array<{ id, contentFile, contentPath }>` — effective aspects with content paths.
- `loadSourceFiles(filePaths, projectRoot): Promise<Array<{ path, content }>>` — reads files, skips unreadable.

## Failure Modes

- Throws on: empty reviewed reason, non-existent node, node without mapping.
- Returns `'refused'` (not throw): blackbox, anti-laundering, unilateral changes.
