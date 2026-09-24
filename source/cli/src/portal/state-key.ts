import path from 'node:path';
import { statPath } from '../io/graph-fs.js';
import { worktreeFingerprint } from '../utils/git.js';

/**
 * portal/state-key — a key for the project state a PortalData extraction
 * depends on, so the server can tell "nothing changed since the last
 * extraction" from "something did" without extracting again.
 *
 * It covers everything an extraction reads that can move under a running
 * server: the HEAD commit and every changed or untracked path under the
 * project, as git reports them, each with its size and modification time, and
 * the gitignored lock files beside the graph, which git does not report at all.
 * A tracked, unmodified file is HEAD's content by definition; a gitignored
 * source file is outside what the portal counts. Null when there is no git
 * repository to ask: the caller then reuses nothing.
 */

/** The gitignored files under the graph root that an extraction reads. */
const LOCAL_LOCK_FILES = ['.yg-lock.deterministic.json'];

export function portalStateKey(projectRoot: string): Promise<string | null> {
  return worktreeFingerprint(
    projectRoot,
    LOCAL_LOCK_FILES.map((name) => path.join(projectRoot, '.yggdrasil', name)),
    sizeAndTime,
  );
}

/** A file's size and modification time, or `absent` — a missing file is a state too. */
async function sizeAndTime(absPath: string): Promise<string> {
  try {
    const s = await statPath(absPath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'absent';
  }
}
