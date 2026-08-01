import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import { committedLockContentHash } from '../../io/lock-store.js';

/**
 * portal/api/attestation — the committed-lock content hash + the git HEAD commit ref, both
 * read-only. Split out of engine-api.ts so each file stays a focused unit (mirrors the other
 * api/*.ts children this facade already wraps — boundary.ts, suppress-scan.ts, freshness.ts,
 * type-coverage.ts, source-file-counts.ts). Wrapped, not called directly by the pipeline — the
 * facade re-exports both under its own name so the single-seam guarantee holds.
 */

/**
 * The content hash of the COMMITTED lock triad. Reuses the engine's own
 * `committedLockContentHash` (it folds only the committed nondeterministic + logs files,
 * excluding the gitignored deterministic cache, so the hash is stable across machines for one
 * commit). This is a content-addressed digest of the committed lock ARTIFACT for attestation —
 * never a re-derivation of a verdict or count. Returns '' when no committed lock exists yet.
 *
 * `graph.rootPath` is the `.yggdrasil/` directory the lock files live in.
 */
export function computePortalLockHash(graph: Graph): string {
  return committedLockContentHash(graph.rootPath);
}

/**
 * The current git HEAD commit ref (full sha), read read-only from `.git`. Resolves `.git/HEAD`:
 * a detached HEAD holds the sha directly; a `ref: refs/...` line is followed to the ref file
 * (or the packed-refs fallback). Returns `null` for a non-git directory or any unreadable /
 * malformed HEAD — the digest then states "no commit ref" rather than inventing one. Never
 * spawns a process and never writes; a bounded set of direct file reads under `.git/`.
 *
 * A LINKED WORKTREE's `.git` is not a directory but a pointer FILE (`gitdir: <path>`) to a
 * private per-worktree git-dir under the main repo's `.git/worktrees/<name>/` — that private
 * dir holds this worktree's own `HEAD` (a worktree can be on a different branch than the main
 * checkout), but `refs/heads/*` and `packed-refs` are SHARED and live in the main repo's git-dir,
 * reachable from the private dir's `commondir` file. Both forms are resolved here so the digest
 * reports the real commit whether `yg` runs from the main checkout or a linked worktree.
 *
 * `projectRoot` is the repo root (the parent of `.yggdrasil/`).
 */
export function readGitCommitRef(projectRoot: string): string | null {
  const dotGit = path.join(projectRoot, '.git');
  let dotGitStat;
  try {
    dotGitStat = statSync(dotGit);
  } catch {
    return null;
  }
  let gitDir: string;
  if (dotGitStat.isDirectory()) {
    gitDir = dotGit;
  } else {
    // Linked worktree / submodule: `.git` is a pointer FILE (`gitdir: <path>`).
    let dotGitContent: string;
    try {
      dotGitContent = readFileSync(dotGit, 'utf-8');
    } catch {
      return null;
    }
    const pointerMatch = dotGitContent.match(/^gitdir:\s*(.+?)\s*$/);
    if (!pointerMatch) return null;
    gitDir = resolveRelative(projectRoot, pointerMatch[1]);
  }
  const headFile = path.join(gitDir, 'HEAD');
  if (!existsSync(headFile)) return null;
  let head: string;
  try {
    head = readFileSync(headFile, 'utf-8').trim();
  } catch {
    return null;
  }
  // Detached HEAD: the file holds the sha directly (SHA-1 = 40 hex, SHA-256 = 64 hex).
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(head)) return head;
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (!refMatch) return null;
  const refName = refMatch[1].trim();

  // Refs are shared across worktrees in the COMMON dir. A linked worktree's private git-dir
  // carries a `commondir` file (relative path to the shared main git-dir); a normal checkout
  // has no such file, so refs live directly under `gitDir` (commonDir === gitDir).
  let commonDir = gitDir;
  const commondirFile = path.join(gitDir, 'commondir');
  if (existsSync(commondirFile)) {
    try {
      commonDir = resolveRelative(gitDir, readFileSync(commondirFile, 'utf-8').trim());
    } catch {
      /* fall back to gitDir itself */
    }
  }

  // Loose ref: <commonDir>/<refName> holds the sha.
  const looseRef = path.join(commonDir, refName);
  if (existsSync(looseRef)) {
    try {
      const sha = readFileSync(looseRef, 'utf-8').trim();
      if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha)) return sha;
    } catch {
      /* fall through to packed-refs */
    }
  }
  // Packed ref fallback: <commonDir>/packed-refs maps `<sha> <refName>`.
  const packed = path.join(commonDir, 'packed-refs');
  if (existsSync(packed)) {
    try {
      const lines = readFileSync(packed, 'utf-8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\s+(.+)$/i);
        if (m && m[2].trim() === refName) return m[1];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve `target` against `base` unless already absolute — shared by the `gitdir`/`commondir`
 *  pointer-file resolution above (both may hold a POSIX-relative or an absolute path). */
function resolveRelative(base: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(base, target);
}
