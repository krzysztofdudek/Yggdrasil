// source/cli/src/model/packages.ts — the three package-consumption documents.
//
// A marketplace is an ordinary git repository that publishes law: a manifest at
// its root naming the packages it carries. A package is a directory of ordinary
// Yggdrasil aspects plus a manifest declaring its version, the CLI major it
// needs, which directories are aspects, and which configuration keys those
// aspects read. A consumer's lock records what was copied in and what each
// copied file hashed to.
//
// There is no registry: identity comes from the URL the consumer typed, so the
// same package published from two forks is two different installations and
// neither can claim the other's name.

/** One package advertised by a marketplace manifest. */
export interface MarketplaceEntry {
  /** Single path segment — the package's name inside this marketplace. */
  name: string;
  /** Repository-relative POSIX directory holding the package. Never escapes the marketplace root. */
  path: string;
  /** Semver of the package as the marketplace currently publishes it. */
  version: string;
}

/** `yg-marketplace.yaml` at a marketplace repository's root. */
export interface MarketplaceManifest {
  schema: 'yg-marketplace/1';
  /** May legally be empty — a marketplace that publishes nothing yet. */
  packages: MarketplaceEntry[];
}

/** The value kinds a package may declare for a configuration key. */
export type PackageConfigType = 'string' | 'number' | 'boolean';

/** One configuration key a package's aspect reads through `ctx.config`. */
export interface PackageConfigKeyDef {
  type: PackageConfigType;
  /** Value used when the consumer's adapt does not override the key. Must match `type`. */
  default: string | number | boolean;
}

/**
 * Per-aspect configuration schema, keyed by the aspect's directory name inside
 * the package (its relative id), then by configuration key.
 */
export type PackageConfigSchema = Record<string, Record<string, PackageConfigKeyDef>>;

/** `yg-package.yaml` at a package directory's root. */
export interface PackageManifest {
  schema: 'yg-package/1';
  /** Single path segment — no slashes, so a package can never claim a nested identity. */
  name: string;
  version: string;
  requires: {
    /** Major-version range of the CLI this package needs, e.g. `6.x` or `>=6`. */
    yg: string;
  };
  /** Directory names beside the manifest, each an ordinary aspect. May be empty. */
  aspects: string[];
  config?: PackageConfigSchema;
}

/** One installed package's record in the consumer's lock. */
export interface PackagesLockEntry {
  /** The URL or path the consumer installed from, verbatim. */
  source: string;
  /** Install identity `<owner>/<repo>/<name>` — the directory under `aspects/packages/`. */
  package: string;
  version: string;
  /** ISO timestamp of the install. Never a hash ingredient. */
  installed_at: string;
  /**
   * POSIX path RELATIVE TO `.yggdrasil/aspects/` → sha256 of the copied file,
   * line endings normalized (io/hash.ts's `hashFile`, so the same package
   * checked out with CRLF still matches), for every file copied in. That base is
   * deliberate: it makes every key start `packages/<owner>/<repo>/<name>/…`,
   * which IS the aspect-id namespace, so a lock line and an aspect id read as
   * the same address. Never includes an adapt file: an adapt is the consumer's
   * own writing, not the package's, and the file-modified rail must never
   * object to it.
   */
  files: Record<string, string>;
}

/**
 * `.yggdrasil/yg-packages.yaml` — the consumer's record of what is installed.
 *
 * This document is about INTEGRITY: what was copied in, from where, and what
 * every file hashed to. What a source has published SINCE is a different
 * question about a different thing — the outside world rather than this
 * repository — and lives in its own local cache, so knowledge that changes on
 * its own can never churn a committed record of what was installed.
 */
export interface PackagesLock {
  schema: 'yg-packages/1';
  /** Keyed by package name — the same name `yg pack update` / `remove` take. */
  packages: Record<string, PackagesLockEntry>;
}

/** The directory, relative to `.yggdrasil/aspects/`, that every installed package lives under. */
export const PACKAGES_DIR = 'packages';

/** The consumer's per-aspect adaptation file, written beside every copied aspect. */
export const ADAPT_FILENAME = 'yg-aspect.adapt.yaml';

/** The consumer's lock filename, directly under `.yggdrasil/`. */
export const PACKAGES_LOCK_FILENAME = 'yg-packages.yaml';

/** A marketplace repository's root manifest filename. */
export const MARKETPLACE_FILENAME = 'yg-marketplace.yaml';

/** A package directory's own manifest filename. */
export const PACKAGE_FILENAME = 'yg-package.yaml';
