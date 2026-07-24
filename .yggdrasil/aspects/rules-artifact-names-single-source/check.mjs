import { walk, report } from '@chrisdudek/yg/ast';

/**
 * Rules-artifact-names single-source boundary.
 *
 * The three names `yg init` installs into an adopter's repository — AGENTS.md,
 * CLAUDE.md, .clinerules/yggdrasil.md — have exactly one legitimate home:
 * utils/rules-artifact-names.ts. Every other module that needs one imports it
 * from there instead of typing the name out again.
 *
 * DIRECTORY-scoped, like no-buildissuemessage-in-engine (this same repo): the
 * guard covers the WHOLE shipped CLI source tree, so a module that does not
 * exist yet is already covered the day it is written. That is the point — the
 * failure mode this rule exists for is "a FOURTH consumer learns these names
 * independently and drifts", and a rule keyed on the three modules that were
 * already fixed cannot see a fourth one at all.
 *
 * Scope boundaries, and why each is where it is:
 *   - `source/cli/src/**` only. The TEST tree is deliberately outside: tests
 *     assert on these names as expected VALUES (a fixture writing AGENTS.md and
 *     asserting the installer found it must say the name), which is data, not a
 *     second definition that can drift out of sync with the installer.
 *   - the owning module itself is excluded — it legitimately holds every one of
 *     these literals, as its own `export const` values.
 */
const GUARDED_PREFIX = 'source/cli/src/';

/** The ONE legitimate home of these names — its own literals are the definition. */
const OWNING_MODULE = 'source/cli/src/utils/rules-artifact-names.ts';

// Exact literal values (case-insensitive) that must come from
// utils/rules-artifact-names.ts instead of being re-typed. Matching by exact
// value only — never substring — so a legitimate string that merely CONTAINS
// one of these (e.g. the retired '.windsurf/rules/yggdrasil.md' artifact path,
// or a sentence of prose interpolating the imported constant) is never a hit.
const FORBIDDEN = new Set([
  'agents.md',
  'claude.md',
  '.clinerules',
  'yggdrasil.md',
  '.clinerules/yggdrasil.md',
  '@agents.md',
]);

/**
 * Documented per-file, per-VALUE exemptions: same bytes, provably a different
 * concept, so importing the shared constant there would be wrong rather than
 * merely verbose. Keyed by (file, value) — never by file alone — so an exempt
 * file stays fully guarded for every OTHER name.
 *
 * portal/api/suppress-eligibility.ts · '.clinerules' — Cline's LEGACY
 * single-file convention: a repository-root file literally NAMED `.clinerules`,
 * with no extension, which `yg init` has never written. The eligibility rule
 * matches it by BASE NAME to classify it as prose. The shared constant is the
 * DIRECTORY `yg init` writes today (`.clinerules/yggdrasil.md`); pointing the
 * base-name test at it would silently re-aim that test at a different artifact.
 * The two are the same string by coincidence, not by shared definition — so
 * this one value, in this one file, must NOT be imported.
 */
const VALUE_EXEMPTIONS = new Map([
  ['source/cli/src/portal/api/suppress-eligibility.ts', new Set(['.clinerules'])],
]);

function isExempt(filePath, lowerValue) {
  return VALUE_EXEMPTIONS.get(filePath)?.has(lowerValue) === true;
}

/**
 * Literal string value of a `string` / non-interpolated `template_string` node,
 * else undefined.
 *
 * A node carrying ANY escape sequence is skipped: none of the guarded names
 * contains one, so a literal that is exactly one of them always decodes from a
 * single plain fragment. Reading only the first fragment of an escaped literal
 * would truncate it (`'AGENTS.md\n…'` → `AGENTS.md`) and report a false hit —
 * harmless while the guard saw three known files, a real hazard now that it
 * sees the whole source tree.
 */
function stringValue(node) {
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  for (const child of node.namedChildren) {
    if (child.type === 'escape_sequence') return undefined; // cannot be one of the names
    // interpolated — e.g. `${AGENTS_FILENAME} digest block` — never a hit
    if (child.type === 'template_substitution') return undefined;
  }
  return node.namedChildren
    .filter((c) => c.type === 'string_fragment')
    .map((c) => c.text)
    .join('');
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!file.path.startsWith(GUARDED_PREFIX)) continue;
    if (file.path === OWNING_MODULE) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'string' && node.type !== 'template_string') return;
      const value = stringValue(node);
      if (value === undefined) return;
      const lower = value.toLowerCase();
      if (!FORBIDDEN.has(lower)) return;
      if (isExempt(file.path, lower)) return false;
      violations.push(
        report(
          file,
          node,
          `hardcoded artifact-name literal '${value}' — import it from utils/rules-artifact-names.ts ` +
            '(AGENTS_FILENAME / CLAUDE_FILENAME / CLINERULES_DIR / CLINERULES_FILENAME / ' +
            'CLINERULES_RELATIVE_PATH / AGENTS_IMPORT_LINE_LOWER) instead of re-typing the name. The ' +
            'installer (templates/platform.ts) and the committed-digest reader (cli/rules-artifacts.ts) once ' +
            'disagreed about the literal AGENTS.md filename this way — a case-variant repository\'s rules were ' +
            'silently unreadable by the drift check — because each computed the name independently; importing ' +
            'from one shared module makes that divergence impossible to reintroduce.',
        ),
      );
      return false; // don't descend into the literal's own fragment children
    });
  }
  return violations;
}
