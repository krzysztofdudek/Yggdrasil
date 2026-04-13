import { execFileSync } from 'node:child_process';

/**
 * Returns Unix timestamp (seconds) of the last commit touching the given path,
 * or null if not a git repo or path has no commits.
 * Path is relative to projectRoot.
 */
export function getLastCommitTimestamp(projectRoot: string, relativePath: string): number | null {
  const normalized = relativePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', normalized], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ts = parseInt(out.trim(), 10);
    return Number.isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}
