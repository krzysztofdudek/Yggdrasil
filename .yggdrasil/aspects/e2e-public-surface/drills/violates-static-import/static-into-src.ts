// DRILL — expected verdict: REFUSED (1 violation).
// Verify with a REPO-RELATIVE --files path: the resolver is textual, and the
// five ../ segments walk from drills/<case>/ back to the repo root before
// descending into source/cli/src/. An e2e test must never statically import a
// CLI internal like this — it should spawn bin.js and read committed artifacts.
import { runCheck } from '../../../../../source/cli/src/core/check.js';

export async function run(root: string): Promise<number> {
  const result = await runCheck({ rootPath: root });
  return result.errors.length;
}
