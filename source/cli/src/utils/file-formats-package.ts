/**
 * source/cli/src/utils/file-formats-package.ts — the schemas of the three
 * package documents: a package's yg-package.yaml, a marketplace's
 * yg-marketplace.yaml and the consumer's .yggdrasil/yg-packages.yaml record.
 *
 * Unlike the graph's own files, these three carry a schema id (`yg-package/1`,
 * …), and the family rule for a versioned document holds for them: a field
 * added within `/1` is ignored by a reader that does not know it, so a package
 * written for a later 6.x can still be read by this one. Their mappings are
 * therefore open — a key not declared here is ignored, not refused — while
 * every declared key is checked as strictly as anywhere else. See
 * file-schema.ts for what a schema drives.
 */

import type { FileFormatSchema, ObjectType } from './file-schema.js';

const OPEN = 'a field added within a /1 document is ignored by a reader that does not know it, the rule every versioned family document follows (family-contracts)';

const semver = { kind: 'string', nonEmpty: true, format: 'semver' } as const;

/** One declared setting of a package rule: `config.<rule>.<key>`. */
const PACKAGE_CONFIG_KEY: ObjectType = {
  kind: 'object',
  open: OPEN,
  fields: {
    type: { type: { kind: 'string', values: ['string', 'number', 'boolean'] }, required: true, description: 'The type a consumer\'s value must have.' },
    default: { type: { kind: 'scalar' }, required: true, description: 'The value the rule reads until a consumer adapts it; of the declared type.' },
  },
};

/** The top level of a yg-package.yaml. */
const PACKAGE_ROOT: ObjectType = {
  kind: 'object',
  open: OPEN,
  fields: {
    schema: { type: { kind: 'string', values: ['yg-package/1'] }, required: true, description: 'The document version.' },
    name: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'The package name, one path segment; the directory it installs under.' },
    version: { type: semver, required: true, description: 'The package version.' },
    requires: {
      type: { kind: 'object', open: OPEN, fields: { yg: { type: { kind: 'string', nonEmpty: true, format: 'semver range' }, required: true, description: 'The Yggdrasil versions the package runs on (e.g. "6.x"); checked when it is installed.' } } },
      required: true,
      description: 'What the package needs.',
    },
    aspects: { type: { kind: 'list', of: { kind: 'string', nonEmpty: true } }, required: true, description: 'The rule directories beside the manifest, each one path segment; every directory must be declared and every declared one present.' },
    config: { type: { kind: 'map', key: 'rule', of: { kind: 'map', key: 'key', of: PACKAGE_CONFIG_KEY } }, description: 'The settings each rule reads through ctx.config, with their types and defaults.' },
  },
};

export const PACKAGE_FORMAT: FileFormatSchema = {
  name: 'package',
  file: '<package directory>/yg-package.yaml',
  summary: 'Package manifest (yg-package/1) — name, version, requires.yg, the rules it ships, their settings.',
  root: PACKAGE_ROOT,
};

/** One entry of a marketplace's `packages:`. */
const MARKETPLACE_ENTRY: ObjectType = {
  kind: 'object',
  open: OPEN,
  fields: {
    name: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'The package name, one path segment, unique in the marketplace.' },
    path: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'The package directory, relative to the marketplace root.' },
    version: { type: semver, required: true, description: 'The version published.' },
  },
};

/** The top level of a yg-marketplace.yaml. */
const MARKETPLACE_ROOT: ObjectType = {
  kind: 'object',
  open: OPEN,
  fields: {
    schema: { type: { kind: 'string', values: ['yg-marketplace/1'] }, required: true, description: 'The document version.' },
    packages: { type: { kind: 'list', of: MARKETPLACE_ENTRY }, required: true, description: 'The packages this marketplace publishes (an empty list is legal).' },
  },
};

export const MARKETPLACE_FORMAT: FileFormatSchema = {
  name: 'marketplace',
  file: '<marketplace root>/yg-marketplace.yaml',
  summary: 'Marketplace manifest (yg-marketplace/1) — the packages a marketplace repository publishes.',
  root: MARKETPLACE_ROOT,
};

/** One installed package's record in `yg-packages.yaml`. */
const PACKAGES_ENTRY: ObjectType = {
  kind: 'object',
  open: OPEN,
  fields: {
    source: { type: { kind: 'string', nonEmpty: true }, required: true, description: 'Where the package was installed from.' },
    package: { type: { kind: 'string', nonEmpty: true, format: '<owner>/<repo>/<name>' }, required: true, description: 'The install directory under aspects/packages/.' },
    version: { type: semver, required: true, description: 'The installed version.' },
    requested: { type: { kind: 'string', nonEmpty: true }, description: 'What was asked for: latest, or a version.' },
    tag: { type: { kind: 'string', nonEmpty: true, format: 'pack/<name>@<version>' }, description: 'The tag the copy came from.' },
    commit: { type: { kind: 'string', nonEmpty: true, format: 'git commit id' }, description: 'The commit that tag pointed at.' },
    identity: { type: { kind: 'string', values: ['given'] }, description: 'given when the install identity was named by hand.' },
    installed_at: { type: { kind: 'string', nonEmpty: true, format: 'ISO timestamp' }, required: true, description: 'When it was installed.' },
    files: { type: { kind: 'map', key: 'path', of: { kind: 'string', format: 'sha256 hex' } }, required: true, description: 'Every copied file, with its hash at install; the package-file-modified rail compares against it.' },
  },
};

/** The top level of `.yggdrasil/yg-packages.yaml`. */
const PACKAGES_ROOT: ObjectType = {
  kind: 'object',
  open: OPEN,
  fields: {
    schema: { type: { kind: 'string', values: ['yg-packages/1'] }, required: true, description: 'The document version.' },
    packages: { type: { kind: 'map', key: 'package', of: PACKAGES_ENTRY }, description: 'The installed packages, by name.' },
  },
};

export const PACKAGES_FORMAT: FileFormatSchema = {
  name: 'packages',
  file: '.yggdrasil/yg-packages.yaml',
  summary: 'Package record (yg-packages/1) — what is installed, from where, and every copied file\'s hash. Written by yg pack.',
  root: PACKAGES_ROOT,
};
