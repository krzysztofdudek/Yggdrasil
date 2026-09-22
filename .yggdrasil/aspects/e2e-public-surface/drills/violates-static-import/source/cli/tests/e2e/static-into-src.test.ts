// DRILL — expected verdict: REFUSED (1 violation).
// The case sits under its repository path, so the rule sees it at
// source/cli/tests/e2e/ and `../../src/` resolves into source/cli/src/. An e2e
// test must never statically import a CLI internal like this — it should spawn
// bin.js and read committed artifacts.
import { runCheck } from '../../src/core/check.js';

export async function run(root: string): Promise<number> {
  const result = await runCheck({ rootPath: root });
  return result.errors.length;
}
