import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/java/spec.ts — the Java golden's builder spec.
// 100 `src/mod<i>/Handler<i>.java` files, one public class (type kind,
// its body contains the two methods below it) with two methods (method
// kind). Raw scopes: 100 * (1 type + 2 method + 1 file) = 400, clearing
// spec §6.8's 300-scope floor with 33% margin. No `extends`/`implements`,
// no imports (`System.out` is a JDK builtin, no `import` needed) — same
// "eliminate two whole enumerators by construction" shape the typescript
// golden uses. `arity`/`ret` carry the same deliberate 50/50 split
// (MUST-NOT-mine: `exec<i>_0` takes 0 params and returns a literal,
// `exec<i>_1` takes 1 param and returns it); both methods call
// `System.out.println` uniformly (MUST-mine).
// =============================================================================

const PACKAGE_COUNT = 100;

function classFile(i: number): string {
  return [
    `public class Handler${i} {`,
    `    public int exec${i}_0() {`,
    `        System.out.println("x");`,
    `        return 1;`,
    `    }`,
    `    public int exec${i}_1(int x) {`,
    `        System.out.println("x");`,
    `        return x;`,
    `    }`,
    `}`,
    '',
  ].join('\n');
}

export function buildJavaGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`src/mod${i}/Handler${i}.java`] = classFile(i);
  }

  return {
    name: 'java',
    commits: [{ author: 'roots-golden', files, message: 'seed: 100 uniform handler classes' }],
  };
}
