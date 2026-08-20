import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/go/spec.ts — the Go golden's builder spec. Go
// has no classes/decorators (design §5.4's degradation note names this as
// the expected, correct shape for a measured-but-classless grammar — not a
// defect): every scope this golden produces is `method` kind (a Go
// `function_declaration` never contains a nested scope, so it never
// reclassifies to `type` per spec §6.2's container/leaf rule).
//
// 150 `src/mod<i>/handler<i>.go` files, each with TWO top-level functions
// (method kind) — raw scopes: 150 * (2 method + 1 file) = 450, clearing
// spec §6.8's 300-scope floor with 50% margin (more files than the
// class-bearing goldens need, since without a `type` scope per file there
// are fewer raw scopes per file to begin with). Both functions call
// `fmt.Println` uniformly (MUST-mine `auto.call:fmt.Println`). Every file
// also `import`s `"fmt"`, but under the ported extractor Go yields NO E8
// surfaces at all: `extract.ts`'s `importTargetText` looks for
// `string`/`string_literal` children, while tree-sitter-go's import target
// is an `interpreted_string_literal`, so no scope here carries
// `fileImports` — a faithful port of the prototype's own limitation,
// recorded as a dogfood coverage gap, NOT something this golden asserts.
// Likewise E5 yields nothing for Go (`lastReturnExprType` is undefined on
// every scope), so `auto.ret` never enters the partition's alphabets.
// `Handler<i>_0` takes 0 parameters; `Handler<i>_1` takes 1 — the same
// deliberate 50/50 `auto.arity` split as every other golden
// (MUST-NOT-mine, rejected at spec §9.4a acceptance).
// =============================================================================

const PACKAGE_COUNT = 150;

function handlerFile(i: number): string {
  return [
    'package main',
    '',
    'import "fmt"',
    '',
    `func Handler${i}_0() int {`,
    '\tfmt.Println("x")',
    '\treturn 1',
    '}',
    '',
    `func Handler${i}_1(x int) int {`,
    '\tfmt.Println("x")',
    '\treturn x',
    '}',
    '',
  ].join('\n');
}

export function buildGoGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`src/mod${i}/handler${i}.go`] = handlerFile(i);
  }

  return {
    name: 'go',
    commits: [
      { author: 'roots-golden', files, message: 'seed: 150 uniform handler modules' },
      // D8's time-depth anchor — see tests/fixtures/roots/golden/data/spec.ts's own comment for why.
      { author: 'roots-golden', dayOffset: 400, files: { 'NOTES.md': 'Time-depth anchor commit — no registered grammar, no scopes, no partition marker.\n' }, message: 'chore: trailing note (time-depth anchor)' },
    ],
  };
}
