import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_DIR = path.resolve(__dirname, '../../src/portal');

/**
 * The single-seam structural invariant (the whole point of the facade refactor):
 *
 * The portal extraction pipeline (extract.ts + derive-*.ts) reaches the engine ONLY
 * through the facade. Its module-level imports must resolve to JUST the facade
 * (`./engine-api.js`) and the data contract (`./contract.js`) for any portal-internal
 * dependency — plus pure type imports from the shared model (`../model/**`), which are
 * erased at runtime and carry no graph-level coupling. It must NEVER import an engine
 * subsystem (`../core/**`, `../relations/**`, `../io/**`, `../ast/**`, `../cli/**`,
 * `../formatters/**`) directly. That keeps the spider collapsed: one seam, not a dozen.
 *
 * Read against the REAL source files (no mocking), so a future edit that re-introduces a
 * direct engine import into a pipeline file fails this test immediately.
 */

/**
 * Module specifiers of every static `import ... from '...'` / `export ... from '...'`
 * statement, including multi-line `import {\n  a,\n  b,\n} from '...'` blocks. `[\s\S]*?`
 * lets the `from` clause cross newlines; the non-greedy match stops at the first `from`.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  // Bare side-effect imports: `import '...'`.
  const sideRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = sideRe.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function read(rel: string): string {
  return readFileSync(path.join(PORTAL_DIR, rel), 'utf-8');
}

// The pipeline files — the de-spidered consumers that must reach the engine only via the facade.
const PIPELINE_FILES = ['extract.ts', 'derive-nodes.ts', 'derive-catalogue.ts', 'derive-rest.ts', 'derive-metrics.ts'];

describe('portal — single engine seam (the de-spidered pipeline)', () => {
  for (const file of PIPELINE_FILES) {
    it(`${file} reaches the engine ONLY through the facade (no direct engine subsystem import)`, () => {
      const specs = importSpecifiers(read(file));
      for (const spec of specs) {
        // Node builtins / third-party packages are not portal-internal coupling.
        if (!spec.startsWith('.')) continue;
        // Pure type/shape imports from the shared model are erased at runtime — allowed.
        if (spec.startsWith('../model/')) continue;
        // Sibling portal-internal imports (./engine-api.js, ./contract.js, ./derive-*.js)
        // stay within the portal — allowed.
        if (spec.startsWith('./')) continue;
        // ANY OTHER relative import escapes the portal directory into an engine subsystem
        // (../core, ../relations, ../io, ../ast, ../cli, ../formatters, ...). That is the
        // spider this refactor collapsed — it is forbidden on a pipeline file.
        expect(
          false,
          `${file} imports '${spec}' directly — pipeline files must reach the engine only via ./engine-api.js`,
        ).toBe(true);
      }
    });
  }

  it('extract.ts reaches the engine through the facade (imports ./engine-api.js)', () => {
    expect(importSpecifiers(read('extract.ts'))).toContain('./engine-api.js');
  });

  it('the facade is the one module that imports engine subsystems', () => {
    // The facade legitimately imports engine subsystems — it IS the seam. Assert it does,
    // so the invariant above is meaningful (the coupling moved here, it did not vanish).
    const facade = importSpecifiers(read('engine-api.ts'));
    expect(facade.some((s) => s.startsWith('../core/') || s.startsWith('../cli/'))).toBe(true);
  });
});
