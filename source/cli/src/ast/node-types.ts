import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * One entry of a tree-sitter grammar's `node-types.json` — the subset of the
 * real schema {@link deriveBinding} (in `src/roots/binding.ts`) needs to
 * derive a grammar's binding: whether a node type declares a `name` field and
 * a `body` field (scope rule, spec §6.2), plus its bare `type` name (import
 * and decorator rules match on the name alone). `fields` carries only
 * presence/absence information here — the real schema's per-field detail
 * (multiplicity, allowed child types) is never read by binding derivation, so
 * it is intentionally not modeled.
 */
export interface NodeTypeEntry {
  type: string;
  named?: boolean;
  fields?: Record<string, unknown>;
}

/**
 * Repo-relative directory of a distinct fs root reached while walking up from
 * `startDir` looking for a `package.json` — the CLI package's own root.
 * Returns `null` if none is found before the filesystem root (never expected
 * in this repository, which always has one; guarded rather than thrown so
 * {@link defaultNodeTypesCandidateDirs} always returns a plain array for
 * {@link readNodeTypes}'s single throw point to report on, instead of a
 * second, differently-shaped failure from this helper).
 */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The two real candidate directories for a grammar's `node-types.json`, in
 * resolution order — mirrors `ast/parser.ts`'s own `GRAMMAR_DIRS` reasoning
 * for WASM, applied to node-types.json instead:
 *   1. `<moduleDir>/grammars/` — correct when running from the built `dist/`:
 *      the published bundle is flat (`dist/ast.js`, `dist/grammars/…`), so
 *      `dist/grammars` is exactly `__dirname/grammars`.
 *   2. `<packageRoot>/dist/grammars/` — correct when running from `src/`
 *      under vitest (`__dirname` is `src/ast/`, which has no `grammars/`
 *      sibling); `dist/` itself carries no `package.json`, so walking up from
 *      `src/ast/` to find one and appending `dist/grammars` is safe in both
 *      modes — it never collides with candidate 1 identifying a different
 *      directory than intended.
 * `node-types.json` exists ONLY under `dist/grammars/` (the build copies it
 * there via `tsup.config.ts`'s per-grammar `nodeTypesCandidates` table); the
 * `node_modules` dev-fallback locations `ast/parser.ts`'s WASM resolver
 * probes have WASM but no `node-types.json` at those paths, so this loader
 * does not reuse that resolution and carries no such fallback of its own.
 */
function defaultNodeTypesCandidateDirs(): string[] {
  const dirs = [path.resolve(__dirname, 'grammars')];
  const packageRoot = findPackageRoot(__dirname);
  if (packageRoot !== null) dirs.push(path.join(packageRoot, 'dist', 'grammars'));
  return dirs;
}

/**
 * Reads and parses `tree-sitter-<assetName>.node-types.json` from the first
 * of `candidateDirs` that contains it (default: the two real candidates from
 * {@link defaultNodeTypesCandidateDirs}). `assetName` is the grammar ASSET
 * name, not the registry id — e.g. `c_sharp` (registry id `csharp`) or
 * `php_only` (registry id `php`); see `utils/language-registry.ts`'s
 * `wasmFile` for the mapping.
 *
 * Reads via `node:fs` directly, exactly as `ast/parser.ts` does for WASM —
 * `ast-adapter`'s architecture allowlist has no `persistence-adapter` edge,
 * so routing this through an io helper would create an unsanctioned relation
 * roots' own genericity fence also bans reaching for.
 *
 * Throws loudly (never returns empty, never skips) when neither candidate
 * directory holds the file — the built-binary-guard philosophy this repo's
 * quality gate already applies elsewhere: a silently empty binding would look
 * like a real grammar with zero scopes/imports/decorators, indistinguishable
 * from `deriveBinding`'s legitimate empty-scope-set outcome (spec §6.2, "a
 * grammar that yields an empty scope set is disabled for the session with one
 * incident") instead of the loud build-hygiene failure it actually is. The
 * message names the build command because in CI the directory is always
 * there — the gate builds before it tests — so a real hit of this branch
 * means dist/grammars/ was never populated, which `npm run build` fixes.
 */
export function readNodeTypes(
  assetName: string,
  candidateDirs: string[] = defaultNodeTypesCandidateDirs(),
): NodeTypeEntry[] {
  const filename = `tree-sitter-${assetName}.node-types.json`;
  const tried: string[] = [];
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, filename);
    tried.push(candidate);
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as NodeTypeEntry[];
    }
  }
  throw new Error(
    `Could not find ${filename} (tried: ${tried.join(', ')}). ` +
      `Run 'npm run build' in source/cli/ to populate dist/grammars/ with the shipped grammars' node-types.json files.`,
  );
}
