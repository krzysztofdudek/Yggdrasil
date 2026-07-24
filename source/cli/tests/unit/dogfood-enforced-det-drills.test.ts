import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * M3 — "no drill, no enforced" as a dogfood gate.
 *
 * The doctrine (yg knowledge read cli-reference / drill): an ENFORCED DETERMINISTIC
 * aspect should ship a drill corpus with at least one `violates-*` case, so the rule
 * has a falsifiable regression fixture proving it actually refuses the shape it claims
 * to catch. This test turns that advisory doctrine into an enforced invariant for THIS
 * repo's own aspects: a new enforced deterministic aspect must come with a violates
 * drill, or be added to the reasoned exemption list below.
 *
 * The exemptions are the aspects whose check needs graph / exact-file-path context that
 * the single-file drill model cannot supply (a drill runs one fixture file with no graph
 * and no control over its repo path), so a `violates-*` case cannot exercise them. Each
 * carries its reason; the list is deliberately explicit so it cannot grow silently.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../../..');
const ASPECTS_ROOT = path.join(REPO_ROOT, '.yggdrasil', 'aspects');

// Aspects exempt from the violates-drill requirement, with the reason each cannot be
// drilled by the single-file model. Keep this list SHORT and justified.
const DRILL_EXEMPT: Record<string, string> = {
  'instrument-import-fence': 'keys on exact engine file paths (cli/check.ts, core/check.ts, …); a fixture file cannot occupy those paths.',
  'no-buildissuemessage-in-engine': 'scoped to engine file paths (core/**, io/**, ast/**); a drill fixture is not under those paths.',
  'rules-artifact-names-single-source': 'scoped to the shipped CLI source tree (source/cli/src/**), like no-buildissuemessage-in-engine; a drill case always resolves under .yggdrasil/aspects/<id>/drills/, so it can never occupy that prefix and a violates-* case would come back satisfied — regression-covered instead by the permanent fixture test tests/unit/io/rules-artifact-names-single-source.test.ts, which copies the real check.mjs into a hermetic temp project and drives it through the production AST runner at paths inside and outside the scope.',
  'sibling-test-file': 'needs a declared graph relation to a test-suite node; a single-file drill has no graph.',
  'runcheck-injected-input-parity': 'derives its rule by reading another node\'s file via ctx.graph/ctx.parseAst (a declared relation to cli/core/check); any read of ctx.graph throws GraphAccessTrap under yg drill, which the runner reclassifies as unsupported before the check\'s own logic ever runs, so a violates-* case could never produce a real refusal; regression-covered instead by the permanent negative-direction fixtures tests/fixtures/runcheck-parity + tests/fixtures/runcheck-parity-drift, driven through the real binary by tests/e2e/cli-runcheck-parity.test.ts.',
  'portal/count-parity-via-reuse': 'needs the pipeline node-id manifest and the count-parity integration; not expressible as one file.',
  'reference/doc-shape': 'needs the reference catalogue directory + its _reference-schema.yaml; not a single file.',
  'reference/layout': 'needs the reference catalogue directory layout; not a single file.',
  'reference/section-body': 'needs the catalogue kind schema + section contract; not a single file.',
  'reference/relations/case-has-test': 'needs the matrix test file alongside the case doc; cross-file, no single-file drill.',
  'reference/relations/case-is-tested': 'needs the matrix test file alongside the case doc; cross-file, no single-file drill.',
  'docs-internal-links': 'resolves links across the WHOLE doc set (needs many .md files together), but the drill corpus excludes .md files and runs one file per case; regression-covered instead by tests/e2e/docs-internal-links.test.ts.',
};

/** Recursively find every aspect directory (one holding a yg-aspect.yaml). */
function findAspectDirs(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'drills') continue; // reserved fixture dir, never an aspect
    const full = path.join(dir, entry.name);
    if (existsSync(path.join(full, 'yg-aspect.yaml'))) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
    findAspectDirs(full, root, out);
  }
  return out;
}

function hasViolatesDrill(aspectId: string): boolean {
  const drillsDir = path.join(ASPECTS_ROOT, aspectId, 'drills');
  if (!existsSync(drillsDir)) return false;
  return readdirSync(drillsDir, { withFileTypes: true }).some(
    (e) => e.isDirectory() && e.name.startsWith('violates-'),
  );
}

function status(aspectId: string): string {
  const raw = parseYaml(readFileSync(path.join(ASPECTS_ROOT, aspectId, 'yg-aspect.yaml'), 'utf-8')) as {
    status?: string;
  };
  return raw?.status ?? 'enforced';
}

describe('every enforced deterministic aspect ships a violates drill (or is reasoned-exempt)', () => {
  const aspectIds = findAspectDirs(ASPECTS_ROOT, ASPECTS_ROOT);

  it('finds this repo\'s aspects (sanity: the corpus is non-empty)', () => {
    expect(aspectIds.length).toBeGreaterThan(30);
  });

  it('no enforced deterministic aspect is missing a violates drill without a reasoned exemption', () => {
    const offenders: string[] = [];
    for (const id of aspectIds) {
      // Deterministic = ships a check.mjs.
      if (!existsSync(path.join(ASPECTS_ROOT, id, 'check.mjs'))) continue;
      if (status(id) === 'draft') continue; // draft rules produce no pairs
      // Own-property membership only: a reserved key inherited from
      // Object.prototype ('constructor', 'toString', …) is truthy on DRILL_EXEMPT
      // via the prototype chain, so a bare `DRILL_EXEMPT[id]` would falsely treat
      // such an aspect id as exempt. Object.hasOwn treats a non-own key as absent.
      if (Object.hasOwn(DRILL_EXEMPT, id)) continue;
      if (!hasViolatesDrill(id)) offenders.push(id);
    }
    expect(offenders, `enforced/advisory deterministic aspects lacking a violates-* drill (add one, or add a reasoned entry to DRILL_EXEMPT): ${offenders.join(', ')}`).toEqual([]);
  });

  it('the exemption list has no stale entries (every exempt aspect still exists and still lacks a drill)', () => {
    const stale: string[] = [];
    for (const id of Object.keys(DRILL_EXEMPT)) {
      if (!existsSync(path.join(ASPECTS_ROOT, id, 'yg-aspect.yaml'))) {
        stale.push(`${id} (no such aspect)`);
      } else if (hasViolatesDrill(id)) {
        stale.push(`${id} (now HAS a violates drill — remove the exemption)`);
      }
    }
    expect(stale, `stale DRILL_EXEMPT entries: ${stale.join(', ')}`).toEqual([]);
  });
});
