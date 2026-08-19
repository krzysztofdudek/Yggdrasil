import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/javascript/spec.ts — the JavaScript golden's
// builder spec. Same shape as the typescript golden (see that spec's header
// for the full rationale): 100 `src/mod<i>/file<i>.js` files, one
// `Handler<i>` class (type kind) with two methods (method kind), no
// imports, no heritage. Raw scopes: 100 * 4 = 400 (300-scope floor cleared
// with 33% margin). `auto.arity`/`auto.ret` 50/50 (MUST-NOT-mine);
// `console.log` called uniformly (MUST-mine).
// =============================================================================

const PACKAGE_COUNT = 100;

function classFile(i: number): string {
  return [
    `class Handler${i} {`,
    `  exec${i}_0() {`,
    `    console.log("x");`,
    `    return 1;`,
    `  }`,
    `  exec${i}_1(x) {`,
    `    console.log("x");`,
    `    return x;`,
    `  }`,
    `}`,
    `module.exports = { Handler${i} };`,
    '',
  ].join('\n');
}

export function buildJavaScriptGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`src/mod${i}/file${i}.js`] = classFile(i);
  }

  return {
    name: 'javascript',
    commits: [{ author: 'roots-golden', files, message: 'seed: 100 uniform handler modules' }],
  };
}
