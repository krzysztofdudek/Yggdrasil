import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/data/spec.ts — the data golden's builder spec
// (design §5.4, `integration-design.md:210-216`): data grammars (json/yaml/
// toml) mixed WITH a code grammar in one repo, asserting BOTH halves —
// MUST-mine on the file/module surfaces (shared across data AND code files
// alike) and MUST-NOT-mine on every scope-level enumerator over the data
// files specifically (`tests/unit/roots/golden-data.test.ts`).
//
// SHAPE: `PACKAGE_COUNT` (40) directories `pkg<i>/`, each holding FIVE
// files, all with the SAME single-letter basename shape by construction —
// `enumerate.ts`'s E1 name-shape folding reduces every one of `a`/`b`/`c`/
// `d`/`e` to the identical single-lowercase-run class, so `auto.filenameshape`
// and `auto.modfileshape` converge to ONE value across every file in the
// repo regardless of its grammar:
//   - `a.ts`, `b.ts` — a TypeScript class (type kind) with two methods
//     (method kind), the SAME uniform shape the typescript golden uses
//     (see that spec's own header) — this is the golden's CODE half, the
//     only source of method/type scopes anywhere in this repo.
//   - `c.json`, `d.yaml`, `e.toml` — trivial, valid, single-key documents.
//     Each parses under its own registered grammar (spec §6.1) and yields
//     exactly one scope: the file scope — `binding.ts`'s own committed
//     snapshots for json/yaml/toml (`tests/fixtures/roots/bindings/{json,
//     yaml,toml}.json`) pin an EMPTY scope-node-type set for all three, so
//     no method/type `RawScope` can ever originate from these three files
//     BY CONSTRUCTION — the structural guarantee
//     `tests/unit/roots/golden-data.test.ts`'s MUST-NOT-mine control
//     verifies directly against `parseAndExtractAll`'s own `rawScopes`
//     output, not merely inferred from the mined model.
//
// Five DIRECT files per `pkg<i>/` clears `extract.ts`'s `MIN_MODULE_CODE_FILES`
// (3) — every package directory resolves its own `module` scope (spec
// §6.3), giving 40 uniform module instances for `auto.moddirshape`/
// `auto.modsize`/`auto.modfileshape` to converge on (this repo has no
// package-root marker anywhere, so every file's module-root is the repo
// root and `finalizeUnits`' nearest-of walk stops at the first directory
// clearing the 3-file threshold — here, every `pkg<i>/` itself).
//
// Raw scopes: 40 packages * (2 code files * (1 type + 2 method + 1 file) +
// 3 data files * 1 file) = 40 * (8 + 3) = 440, clearing spec §6.8's
// 300-scope floor with 46% margin.
// =============================================================================

const PACKAGE_COUNT = 40;

const CODE_FILE = [
  'export class Handler {',
  '  exec0() {',
  '    console.log("x");',
  '    return 1;',
  '  }',
  '  exec1(x) {',
  '    console.log("x");',
  '    return x;',
  '  }',
  '}',
  '',
].join('\n');

const JSON_FILE = '{"key": "value"}\n';
const YAML_FILE = 'key: value\n';
const TOML_FILE = 'key = "value"\n';

export function buildDataGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`pkg${i}/a.ts`] = CODE_FILE;
    files[`pkg${i}/b.ts`] = CODE_FILE;
    files[`pkg${i}/c.json`] = JSON_FILE;
    files[`pkg${i}/d.yaml`] = YAML_FILE;
    files[`pkg${i}/e.toml`] = TOML_FILE;
  }

  return {
    name: 'data',
    commits: [{ author: 'roots-golden', files, message: 'seed: 40 uniform packages mixing code and data files' }],
  };
}
