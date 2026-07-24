import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The CLI's own package name — the walk below only trusts a package.json that
// carries this name, so it never returns a consumer project's version.
const OWN_PACKAGE_NAME = '@chrisdudek/yg';

/**
 * Resolve the CLI's own version from ITS package.json, robustly under both
 * runtime layouts this module can execute in:
 *
 *  - Bundled (`dist/bin.js`): tsup bundles every module `bin.ts` imports into
 *    ONE output file (splitting is disabled), so `import.meta.url` for this
 *    module evaluates to that single file's URL — `dist/bin.js`. Its
 *    directory is `dist/`, one level below `package.json`.
 *  - Direct-from-source (vitest imports `src/cli/cli-version.ts` unbundled):
 *    `import.meta.url` is this file's own URL, whose directory is
 *    `src/cli/` — two levels below `package.json`.
 *
 * Rather than hardcode either distance (which is only correct for one of the
 * two runtimes), walk up from this module's own directory until a
 * `package.json` is found AND it names `@chrisdudek/yg` — confirming it is
 * this CLI's own manifest, not a consumer project's or an unrelated package
 * encountered while walking. This does not depend on `process.cwd()`, so it
 * is correct regardless of where the command is invoked from.
 */
export function cliVersion(): string {
  const startDir = dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'package.json');
    try {
      const raw = readFileSync(candidate, 'utf-8');
      const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (pkg.name === OWN_PACKAGE_NAME && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch (err) {
      // A genuine "nothing here" (no package.json at this directory) means
      // keep walking up. Anything else — EACCES, EISDIR, malformed JSON — is
      // a real failure reading what IS this CLI's manifest; surface it
      // immediately instead of silently stepping past it and reporting a
      // misleading "could not resolve" once the walk reaches the filesystem
      // root.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not resolve ${OWN_PACKAGE_NAME}'s package.json: reading or parsing ${candidate} failed: ${detail}`,
          { cause: err },
        );
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not resolve ${OWN_PACKAGE_NAME}'s package.json by walking up from ${startDir}.`,
      );
    }
    dir = parent;
  }
}
