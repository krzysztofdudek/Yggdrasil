import { valid as validSemver, satisfies as semverSatisfies, coerce as coerceSemver } from 'semver';
import { parse as parseYaml } from 'yaml';
import { readFileOrDefault } from './read-or-default.js';
import type { IssueMessage } from '../model/validation.js';
import type {
  MarketplaceEntry,
  MarketplaceManifest,
  PackageConfigKeyDef,
  PackageConfigSchema,
  PackageConfigType,
  PackageManifest,
  PackagesLock,
  PackagesLockEntry,
} from '../model/packages.js';
import { PACKAGES_DIR } from '../model/packages.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * source/cli/src/io/package-manifest-parser.ts — read → parse → validate → return
 * for the three package-consumption documents (marketplace manifest, package
 * manifest, consumer lock).
 *
 * Every entry point returns a result union rather than throwing: a malformed
 * manifest belongs to whoever wrote it, and the caller — a command, or the graph
 * loader — is the layer that decides how loudly to say so. The two manifests are
 * EXPECTED files (the caller named the directory they must be in), so their
 * absence is a refusal that names the missing file. The lock is OPTIONAL state:
 * a repository with no packages has no lock, and reading one must yield an empty
 * lock rather than an error.
 */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Array<{ code: string; messageData: IssueMessage }> };

function fail<T>(code: string, messageData: IssueMessage): ParseResult<T> {
  return { ok: false, errors: [{ code, messageData }] };
}

/**
 * True when `p` is not a plain, downward, repository-relative POSIX path. Same
 * rule (and the same reasoning) as `escapesRepo` in aspect-parser.ts: an absolute
 * path, a drive letter, a `~`, or a `..` that climbs above the starting point
 * would let a manifest reach outside the directory it was read from.
 */
function escapesRoot(p: string): boolean {
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith('~')) return true;
  let depth = 0;
  for (const segment of p.split('/')) {
    if (segment === '..') {
      depth--;
      if (depth < 0) return true;
    } else if (segment !== '' && segment !== '.') {
      depth++;
    }
  }
  return false;
}

/** A name that must be exactly one path segment — no separators, no traversal. */
function isSingleSegment(name: string): boolean {
  return (
    name.trim() !== '' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  );
}

/**
 * Shared top-level shape guard. `Array.isArray` is tested explicitly because
 * `typeof [] === 'object'`: without it a YAML sequence document reads as a
 * mapping and every later property access silently yields undefined.
 */
function asMapping(
  raw: unknown,
  filePath: string,
  documentLabel: string,
): ParseResult<Record<string, unknown>> {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('package-manifest-invalid', {
      what: `${documentLabel} at ${filePath} is empty or is not a YAML mapping.`,
      why: `${documentLabel} must be a YAML mapping with a schema: key; a sequence or a scalar carries none of the fields the reader needs.`,
      next: `Rewrite ${filePath} as a YAML mapping.`,
    });
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/** Read a file's text, or return null when it is absent. */
async function readOrNull(filePath: string): Promise<string | null> {
  return readFileOrDefault(filePath, null, 'package-manifest-parser');
}

/**
 * Parse the YAML text of a document, turning a syntax error into a refusal that
 * names the file (and, when the YAML library reports one, the line).
 */
function parseDocument(
  text: string,
  filePath: string,
  documentLabel: string,
): ParseResult<unknown> {
  try {
    return { ok: true, value: parseYaml(text) as unknown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail('package-manifest-invalid', {
      what: `${documentLabel} at ${filePath} is not valid YAML: ${detail}`,
      why: 'The document cannot be read at all until it parses, so nothing in it can be validated.',
      next: `Fix the YAML syntax in ${filePath}. A literal tab character is the usual cause — YAML indentation is spaces only.`,
    });
  }
}

// ============================================================
// yg-marketplace/1
// ============================================================

/**
 * Read and validate a marketplace repository's root manifest.
 *
 * `packages: []` is legal — a marketplace that publishes nothing yet is a valid
 * marketplace, and refusing it would make an empty repository unusable as the
 * starting point it is meant to be.
 */
export async function parseMarketplaceManifest(
  filePath: string,
): Promise<ParseResult<MarketplaceManifest>> {
  const text = await readOrNull(filePath);
  if (text === null) {
    return fail('marketplace-manifest-missing', {
      what: `No ${filePath} found.`,
      why: 'A marketplace is a git repository carrying yg-marketplace.yaml at its root; without that file there is nothing naming the packages it publishes.',
      next: 'Point yg pack add at a repository (or directory) whose root holds yg-marketplace.yaml.',
    });
  }

  const parsed = parseDocument(text, filePath, 'yg-marketplace.yaml');
  if (!parsed.ok) return parsed;
  const mapping = asMapping(parsed.value, filePath, 'yg-marketplace.yaml');
  if (!mapping.ok) return mapping;
  const raw = mapping.value;

  if (raw.schema === undefined) {
    return fail('marketplace-schema-missing', {
      what: `${filePath} has no schema: key.`,
      why: 'The schema line is what lets this build know which document version it is reading; without it the rest cannot be interpreted safely.',
      next: 'Add `schema: yg-marketplace/1` as the first line of the file.',
    });
  }
  if (raw.schema !== 'yg-marketplace/1') {
    return fail('marketplace-schema-unknown', {
      what: `${filePath} declares schema '${String(raw.schema)}', which this build does not know.`,
      why: 'Reading a document under a schema this build has never seen would mean guessing at its fields.',
      next: 'Use `schema: yg-marketplace/1`, or upgrade the CLI to a build that knows this schema.',
    });
  }

  if (!Array.isArray(raw.packages)) {
    return fail('marketplace-packages-invalid', {
      what: `${filePath} has 'packages' that is ${raw.packages === undefined ? 'absent' : 'not a list'}.`,
      why: 'packages: is the list of what this marketplace publishes; anything else names nothing.',
      next: 'Set packages: to a YAML sequence of { name, path, version } entries (an empty sequence is legal).',
    });
  }

  const packages: MarketplaceEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.packages.length; i++) {
    const entry = raw.packages[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail('marketplace-entry-invalid', {
        what: `${filePath}: packages[${i}] is not a mapping.`,
        why: 'Every published package is described by a { name, path, version } mapping.',
        next: `Replace packages[${i}] with a mapping carrying name, path and version.`,
      });
    }
    const obj = entry as Record<string, unknown>;
    for (const field of ['name', 'path', 'version'] as const) {
      if (typeof obj[field] !== 'string' || (obj[field] as string).trim() === '') {
        return fail('marketplace-entry-invalid', {
          what: `${filePath}: packages[${i}] has no '${field}'.`,
          why: 'name, path and version are all required — a package with any of them missing cannot be located or pinned.',
          next: `Add ${field}: to packages[${i}].`,
        });
      }
    }
    const name = (obj.name as string).trim();
    const rawPath = (obj.path as string).trim();
    const version = (obj.version as string).trim();

    if (!isSingleSegment(name)) {
      return fail('marketplace-entry-invalid', {
        what: `${filePath}: packages[${i}] is named '${name}', which is not a single path segment.`,
        why: 'A package name becomes one directory under aspects/packages/<owner>/<repo>/, so it may not carry a separator.',
        next: `Rename the package to a single segment (no '/' or '\\').`,
      });
    }
    if (seen.has(name)) {
      return fail('marketplace-entry-duplicate', {
        what: `${filePath} lists a package named '${name}' more than once.`,
        why: 'Two entries under one name make the name ambiguous — a consumer asking for it could get either.',
        next: `Remove or rename the duplicate '${name}' entry.`,
      });
    }
    seen.add(name);

    const normalizedPath = toPosixPath(rawPath);
    if (escapesRoot(normalizedPath)) {
      return fail('marketplace-entry-escape', {
        what: `${filePath}: packages[${i}] has path '${rawPath}', which leaves the marketplace root.`,
        why: 'A package path is read relative to the marketplace repository, so an absolute path or one climbing above the root would reach files the marketplace does not publish.',
        next: `Use a path inside the marketplace repository, e.g. 'packages/${name}'.`,
      });
    }
    if (validSemver(version) === null) {
      return fail('marketplace-entry-version-invalid', {
        what: `${filePath}: packages[${i}] declares version '${version}', which is not semver.`,
        why: 'The version is what a consumer pins and what an update compares against; an unparseable one can be neither.',
        next: `Set packages[${i}].version to a semver value such as 1.0.0.`,
      });
    }

    packages.push({ name, path: normalizedPath, version });
  }

  return { ok: true, value: { schema: 'yg-marketplace/1', packages } };
}

// ============================================================
// yg-package/1
// ============================================================

const CONFIG_TYPES: readonly PackageConfigType[] = ['string', 'number', 'boolean'];

function configValueMatchesType(value: unknown, type: PackageConfigType): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a `config:` block against the aspect list the package declares.
 *
 * A schema entry for an aspect the package does not carry is refused rather than
 * ignored: it would read as configuration a consumer could set and nothing would
 * ever consume, which is worse than a missing key.
 */
function parseConfigSchema(
  raw: unknown,
  filePath: string,
  aspects: string[],
): ParseResult<PackageConfigSchema> {
  if (raw === undefined) return { ok: true, value: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('package-config-schema-invalid', {
      what: `${filePath}: 'config' is not a mapping.`,
      why: 'config: maps an aspect name to the keys that aspect reads through ctx.config.',
      next: 'Write config: as a mapping of aspect name to { key: { type, default } }.',
    });
  }

  const schema: PackageConfigSchema = {};
  for (const [aspectName, keysRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!aspects.includes(aspectName)) {
      return fail('package-config-schema-unknown-aspect', {
        what: `${filePath}: config declares keys for aspect '${aspectName}', which this package does not carry.`,
        why: 'Configuration is read by an aspect; a schema for an aspect that is not in this package could never be read by anything.',
        next: `Remove the '${aspectName}' block from config:, or add '${aspectName}' to aspects:.`,
      });
    }
    if (keysRaw === null || typeof keysRaw !== 'object' || Array.isArray(keysRaw)) {
      return fail('package-config-schema-invalid', {
        what: `${filePath}: config.${aspectName} is not a mapping.`,
        why: "Each aspect's configuration block maps a key name to its { type, default }.",
        next: `Write config.${aspectName} as a mapping of key to { type, default }.`,
      });
    }
    const keys: Record<string, PackageConfigKeyDef> = {};
    for (const [keyName, defRaw] of Object.entries(keysRaw as Record<string, unknown>)) {
      if (defRaw === null || typeof defRaw !== 'object' || Array.isArray(defRaw)) {
        return fail('package-config-schema-invalid', {
          what: `${filePath}: config.${aspectName}.${keyName} is not a mapping.`,
          why: 'Every configuration key declares its type and the default used when a consumer adapts nothing.',
          next: `Write config.${aspectName}.${keyName} as { type: <string|number|boolean>, default: <value> }.`,
        });
      }
      const def = defRaw as Record<string, unknown>;
      const type = def.type;
      if (typeof type !== 'string' || !CONFIG_TYPES.includes(type as PackageConfigType)) {
        return fail('package-config-key-type-missing', {
          what: `${filePath}: config.${aspectName}.${keyName} declares type '${String(type)}'.`,
          why: 'A key with no declared type cannot be checked against what a consumer writes in an adapt.',
          next: `Set config.${aspectName}.${keyName}.type to one of: string, number, boolean.`,
        });
      }
      const declaredType = type as PackageConfigType;
      if (!configValueMatchesType(def.default, declaredType)) {
        return fail('package-config-default-type-mismatch', {
          what: `${filePath}: config.${aspectName}.${keyName} has type '${declaredType}' but a default of type '${def.default === null ? 'null' : typeof def.default}'.`,
          why: 'A default that does not satisfy its own declared type is the value every consumer gets until they adapt it.',
          next: `Give config.${aspectName}.${keyName}.default a ${declaredType} value.`,
        });
      }
      keys[keyName] = { type: declaredType, default: def.default as string | number | boolean };
    }
    schema[aspectName] = keys;
  }
  return { ok: true, value: schema };
}

/**
 * Read and validate a package's own manifest.
 *
 * The `requires.yg` range is READ here but not JUDGED here: whether the running
 * build satisfies it is `checkPackageRequires`'s question, asked at install time.
 * Keeping the two apart means loading a graph never depends on which CLI version
 * is running, so an already-installed package cannot become unloadable — and
 * therefore un-removable — after an upgrade.
 *
 * `presentAspectDirs`, when supplied, is the set of directories actually sitting
 * beside the manifest. It is checked in BOTH directions: a declared directory
 * that is not there is a package that promises law it does not ship, and a
 * directory that is there but undeclared is law that would be copied in without
 * ever being named — the second is the one that matters, because it is how an
 * extra rule could ride in unannounced.
 */
export async function parsePackageManifest(
  filePath: string,
  presentAspectDirs?: string[],
): Promise<ParseResult<PackageManifest>> {
  const text = await readOrNull(filePath);
  if (text === null) {
    return fail('package-manifest-missing', {
      what: `No ${filePath} found.`,
      why: 'A package is a directory carrying yg-package.yaml; without it there is nothing declaring the version, the CLI it needs, or which directories are aspects.',
      next: 'Check the path: entry in the marketplace manifest points at a directory holding yg-package.yaml.',
    });
  }

  const parsed = parseDocument(text, filePath, 'yg-package.yaml');
  if (!parsed.ok) return parsed;
  const mapping = asMapping(parsed.value, filePath, 'yg-package.yaml');
  if (!mapping.ok) return mapping;
  const raw = mapping.value;

  if (raw.schema !== 'yg-package/1') {
    return fail('package-schema-unknown', {
      what: `${filePath} declares schema '${String(raw.schema)}'${raw.schema === undefined ? ' (absent)' : ''}, which this build does not know.`,
      why: 'The schema line is what lets this build know which document version it is reading.',
      next: 'Use `schema: yg-package/1`, or upgrade the CLI to a build that knows this schema.',
    });
  }

  if (typeof raw.name !== 'string' || !isSingleSegment(raw.name.trim())) {
    return fail('package-name-invalid', {
      what: `${filePath} declares name '${String(raw.name)}', which is not a single path segment.`,
      why: 'A package name becomes one directory under aspects/packages/<owner>/<repo>/, so it may not carry a separator.',
      next: 'Set name: to a single segment with no / or \\.',
    });
  }
  const name = raw.name.trim();

  if (typeof raw.version !== 'string' || validSemver(raw.version.trim()) === null) {
    return fail('package-version-invalid', {
      what: `${filePath} declares version '${String(raw.version)}', which is not semver.`,
      why: 'The version is what the consumer records in the lock and what an update compares against.',
      next: 'Set version: to a semver value such as 1.0.0.',
    });
  }
  const version = raw.version.trim();

  const requiresRaw = raw.requires;
  if (
    requiresRaw === null ||
    typeof requiresRaw !== 'object' ||
    Array.isArray(requiresRaw) ||
    typeof (requiresRaw as Record<string, unknown>).yg !== 'string'
  ) {
    return fail('package-requires-missing', {
      what: `${filePath} has no requires.yg.`,
      why: 'A package runs against a CLI major it was written for; without that declaration the consumer cannot tell whether this build can run it at all.',
      next: 'Add:\n  requires:\n    yg: "6.x"',
    });
  }
  const requiresYg = ((requiresRaw as Record<string, unknown>).yg as string).trim();

  if (!Array.isArray(raw.aspects)) {
    return fail('package-aspects-invalid', {
      what: `${filePath} has 'aspects' that is ${raw.aspects === undefined ? 'absent' : 'not a list'}.`,
      why: 'aspects: names the directories beside the manifest that are rules; anything else names nothing.',
      next: 'Set aspects: to a YAML sequence of directory names (an empty sequence is legal).',
    });
  }
  const aspects: string[] = [];
  for (let i = 0; i < raw.aspects.length; i++) {
    const entry = raw.aspects[i];
    if (typeof entry !== 'string' || !isSingleSegment(entry.trim())) {
      return fail('package-aspects-invalid', {
        what: `${filePath}: aspects[${i}] is '${String(entry)}', which is not a directory name.`,
        why: 'Each aspect is one directory sitting beside the manifest, named by a single path segment.',
        next: `Replace aspects[${i}] with the aspect directory's name.`,
      });
    }
    const dir = entry.trim();
    if (aspects.includes(dir)) {
      return fail('package-aspects-invalid', {
        what: `${filePath} lists aspect directory '${dir}' more than once.`,
        why: 'A duplicate entry hides whether the second one was meant to be a different rule.',
        next: `Remove the duplicate '${dir}' entry from aspects:.`,
      });
    }
    aspects.push(dir);
  }

  if (presentAspectDirs !== undefined) {
    for (const declared of aspects) {
      if (!presentAspectDirs.includes(declared)) {
        return fail('package-aspect-dir-missing', {
          what: `${filePath} declares aspect '${declared}', but no directory of that name sits beside it.`,
          why: 'A declared aspect that is not there would install as a rule the consumer can attach and that can never run.',
          next: `Add the '${declared}' directory to the package, or remove it from aspects:.`,
        });
      }
    }
    for (const present of presentAspectDirs) {
      if (!aspects.includes(present)) {
        return fail('package-aspect-dir-undeclared', {
          what: `The package at ${filePath} carries a directory '${present}' that aspects: does not declare.`,
          why: 'Every directory in a package is copied into the consumer, so an undeclared rule directory would arrive as law nobody announced.',
          next: `Add '${present}' to aspects:, or remove the directory from the package.`,
        });
      }
    }
  }

  const configResult = parseConfigSchema(raw.config, filePath, aspects);
  if (!configResult.ok) return configResult;

  return {
    ok: true,
    value: {
      schema: 'yg-package/1',
      name,
      version,
      requires: { yg: requiresYg },
      aspects,
      ...(Object.keys(configResult.value).length > 0 && { config: configResult.value }),
    },
  };
}

/**
 * Whether the running CLI satisfies a package's `requires.yg`.
 *
 * Asked when a package is being brought IN, where a mismatch is actionable, and
 * never while loading a graph, where it would only strand a package the user can
 * no longer remove.
 */
export function checkPackageRequires(
  manifest: PackageManifest,
  cliVersion: string,
): ParseResult<null> {
  const runningVersion = validSemver(cliVersion) ?? coerceSemver(cliVersion)?.version ?? null;
  if (runningVersion !== null && semverSatisfies(runningVersion, manifest.requires.yg, { includePrerelease: true })) {
    return { ok: true, value: null };
  }
  return fail('package-requires-unsatisfied', {
    what: `The package '${manifest.name}' needs a Yggdrasil matching '${manifest.requires.yg}'; this one is ${cliVersion}.`,
    why: 'The package was written against a different version of the graph format, so its rules may use a shape this build cannot load or judge.',
    next: `Upgrade Yggdrasil to a version satisfying '${manifest.requires.yg}', or install a release of '${manifest.name}' built for ${cliVersion}.`,
  });
}

// ============================================================
// yg-packages/1 (the consumer's lock)
// ============================================================

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** An empty lock — what a repository with no packages installed reads as. */
export function emptyPackagesLock(): PackagesLock {
  return { schema: 'yg-packages/1', packages: {} };
}

/**
 * Read the consumer's package lock.
 *
 * Absence is the empty state, not an error: almost every repository has no
 * packages, and making them all carry an empty file would be ceremony. A lock
 * that IS there but is malformed is refused loudly — a corrupted record read as
 * "nothing installed" would silently un-enforce the file-modified rail over
 * every copied rule.
 */
export async function parsePackagesLock(filePath: string): Promise<ParseResult<PackagesLock>> {
  const text = await readOrNull(filePath);
  if (text === null) return { ok: true, value: emptyPackagesLock() };

  const parsed = parseDocument(text, filePath, 'yg-packages.yaml');
  if (!parsed.ok) return parsed;
  // A file holding only comments parses to null. That is an empty lock, not a
  // malformed one — the same tolerance a freshly-commented-out lock deserves.
  if (parsed.value === null || parsed.value === undefined) return { ok: true, value: emptyPackagesLock() };

  const mapping = asMapping(parsed.value, filePath, 'yg-packages.yaml');
  if (!mapping.ok) return mapping;
  const raw = mapping.value;

  if (raw.schema !== 'yg-packages/1') {
    return fail('packages-lock-schema-unknown', {
      what: `${filePath} declares schema '${String(raw.schema)}'${raw.schema === undefined ? ' (absent)' : ''}, which this build does not know.`,
      why: 'The lock records what every installed rule file hashed to; reading it under a schema this build has not seen would mean guessing.',
      next: 'Use `schema: yg-packages/1`, or upgrade the CLI to a build that knows this schema.',
    });
  }

  const packagesRaw = raw.packages;
  if (packagesRaw === undefined) return { ok: true, value: emptyPackagesLock() };
  if (packagesRaw === null || typeof packagesRaw !== 'object' || Array.isArray(packagesRaw)) {
    return fail('packages-lock-invalid', {
      what: `${filePath}: 'packages' is not a mapping.`,
      why: 'The lock maps each installed package name to what was copied in for it.',
      next: 'Write packages: as a mapping of package name to its record, or delete the file and re-run yg pack add.',
    });
  }

  const packages: Record<string, PackagesLockEntry> = {};
  for (const [pkgName, entryRaw] of Object.entries(packagesRaw as Record<string, unknown>)) {
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) {
      return fail('packages-lock-invalid', {
        what: `${filePath}: the record for '${pkgName}' is not a mapping.`,
        why: 'Each installed package records its source, install identity, version, install time and file hashes.',
        next: `Re-run yg pack add for '${pkgName}' to rewrite the record.`,
      });
    }
    const entry = entryRaw as Record<string, unknown>;
    for (const field of ['source', 'package', 'version', 'installed_at'] as const) {
      if (typeof entry[field] !== 'string' || (entry[field] as string).trim() === '') {
        return fail('packages-lock-entry-incomplete', {
          what: `${filePath}: the record for '${pkgName}' has no '${field}'.`,
          why: 'Without every field the record cannot say what was installed, from where, or when.',
          next: `Re-run yg pack add for '${pkgName}' to rewrite the record.`,
        });
      }
    }

    const installId = (entry.package as string).trim();
    const installPrefix = `${PACKAGES_DIR}/${installId}/`;
    const filesRaw = entry.files;
    if (filesRaw === null || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
      return fail('packages-lock-invalid', {
        what: `${filePath}: the record for '${pkgName}' has 'files' that is not a mapping.`,
        why: 'files: maps each copied file to what it hashed to at install time — it is what the file-modified rail compares against.',
        next: `Re-run yg pack add for '${pkgName}' to rewrite the record.`,
      });
    }

    const files: Record<string, string> = {};
    for (const [rawFilePath, hashRaw] of Object.entries(filesRaw as Record<string, unknown>)) {
      const posix = toPosixPath(rawFilePath);
      if (typeof hashRaw !== 'string' || !SHA256_HEX.test(hashRaw)) {
        return fail('packages-lock-hash-invalid', {
          what: `${filePath}: '${pkgName}' records '${posix}' with hash '${String(hashRaw)}', which is not a sha256 hex digest.`,
          why: 'The rail compares a file against this value byte for byte; a value that is not a digest can never match, and would report every check as tampering.',
          next: `Re-run yg pack add for '${pkgName}' to rewrite the record.`,
        });
      }
      if (!posix.startsWith(installPrefix) || escapesRoot(posix)) {
        return fail('packages-lock-path-escape', {
          what: `${filePath}: '${pkgName}' records the file '${posix}', which is outside its install directory (${installPrefix}).`,
          why: 'A lock entry pointing outside the copy would let the rail claim ownership of a file the package never installed.',
          next: `Re-run yg pack add for '${pkgName}' to rewrite the record.`,
        });
      }
      files[posix] = hashRaw;
    }

    packages[pkgName] = {
      source: (entry.source as string).trim(),
      package: installId,
      version: (entry.version as string).trim(),
      installed_at: (entry.installed_at as string).trim(),
      files,
    };
  }

  return { ok: true, value: { schema: 'yg-packages/1', packages } };
}
