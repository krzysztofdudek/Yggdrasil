import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/tsx/spec.ts — the TSX golden's builder spec.
// Same shape as the typescript golden (see that spec's own header for the
// full sizing/uniformity rationale — repeated only where TSX diverges):
// 100 `src/mod<i>/widget<i>.tsx` files, one `Widget<i>` class (type kind)
// with two methods (method kind), no imports, no heritage. Raw scopes:
// 100 * 4 = 400, clearing spec §6.8's 300-scope floor with the same 33%
// margin. `auto.arity`/`auto.ret` carry the same deliberate 50/50 split
// (MUST-NOT-mine — and unlike the typescript golden, `exec<i>_1` here DOES
// `return x`, so the `auto.ret` half of the split is real: number-literal
// vs identifier, a genuine coin flip on E5's full 200-scope domain); both
// methods call `console.log` uniformly (MUST-mine).
//
// KNOWN LIMITATION (Task 7 review F5, recorded for the maintainer/R10):
// this golden contains NO JSX — it is the typescript golden's shape with
// `.tsx` extensions, so it proves the tsx grammar parses plain
// class/method code, not that JSX nodes survive extraction. Against
// design §5.4's "a grammar is supported when its golden passes" that is
// thinner than the name suggests; R10's seven new goldens must not copy
// this pattern.
// =============================================================================

const PACKAGE_COUNT = 100;

function widgetFile(i: number): string {
  return [
    `export class Widget${i} {`,
    `  exec${i}_0() {`,
    `    console.log("x");`,
    `    return 1;`,
    `  }`,
    `  exec${i}_1(x) {`,
    `    console.log("x");`,
    `    return x;`,
    `  }`,
    `}`,
    '',
  ].join('\n');
}

export function buildTsxGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`src/mod${i}/widget${i}.tsx`] = widgetFile(i);
  }

  return {
    name: 'tsx',
    commits: [{ author: 'roots-golden', files, message: 'seed: 100 uniform widget modules' }],
  };
}
