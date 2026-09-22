// DRILL — expected verdict: SATISFIED (No violations).
// A relative import to a sibling test-support helper is fine: it resolves to a
// path that does NOT land under source/cli/src/, so the rule leaves it alone.
import { readArtifact } from './read-artifact.js';

export function loadLock(dir: string): string {
  return readArtifact(dir, 'yg-lock.nondeterministic.json');
}
