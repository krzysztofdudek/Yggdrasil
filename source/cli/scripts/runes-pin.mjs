#!/usr/bin/env node
// The Runes pin: Yggdrasil takes its relation extractors, parser host and grammar recipe from
// @chrisdudek/runes, installed (never bundled: tsup keeps every dependency external) at one exact
// version. This module holds that pin together, both ways:
//
// - package.json names an exact version (no range), and package-lock.json records the same
//   version for the root dependency and for the installed package;
// - the package installed in node_modules is that version, and so is the version the code
//   actually imports (the `version` export of @chrisdudek/runes/relations);
// - the lock fetches it from one of two places only: the npm registry tarball of that version,
//   or, until Runes is first published to npm, the GitHub archive of the tagged Runes commit
//   (https://codeload.github.com/krzysztofdudek/Runes/tar.gz/<commit>), always with an
//   integrity hash, so the bytes are pinned either way.
//
// With --publish the GitHub archive is refused: a published @chrisdudek/yg resolves its
// dependencies from the registry, so publishing before Runes is on npm would ship a package no
// one can install. `npm publish` runs this through prepublishOnly.
//
// Switching to the registry once Runes X.Y.Z is on npm changes no code and not package.json:
//   npm install @chrisdudek/runes@X.Y.Z --save-exact   (in source/cli; rewrites the lock entry)
//
// Usage: node scripts/runes-pin.mjs [--publish]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNES_PACKAGE = '@chrisdudek/runes';
const EXACT = /^\d+\.\d+\.\d+$/;
const REGISTRY = (version) => `https://registry.npmjs.org/${RUNES_PACKAGE}/-/runes-${version}.tgz`;
const GITHUB_ARCHIVE = /^https:\/\/codeload\.github\.com\/krzysztofdudek\/Runes\/tar\.gz\/[0-9a-f]{40}$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Every way the Runes pin of the package at `cliRoot` does not hold, as sentences; empty when
 * it holds. `runtimeVersion` is the `version` export of the installed @chrisdudek/runes (the
 * caller imports it, so the check covers what the code loads). `publish` refuses the GitHub
 * archive source.
 */
export function runesPinProblems(cliRoot, { runtimeVersion, publish = false } = {}) {
  const problems = [];
  const pkg = readJson(path.join(cliRoot, 'package.json'));
  const spec = pkg.dependencies?.[RUNES_PACKAGE];
  if (spec === undefined) return [`package.json does not depend on ${RUNES_PACKAGE}`];
  if (!EXACT.test(spec)) problems.push(`package.json depends on ${RUNES_PACKAGE} "${spec}", not an exact version X.Y.Z`);
  for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[field]?.[RUNES_PACKAGE] !== undefined) problems.push(`package.json lists ${RUNES_PACKAGE} in ${field} as well; it is a runtime dependency only`);
  }

  const lockPath = path.join(cliRoot, 'package-lock.json');
  if (!existsSync(lockPath)) {
    problems.push('package-lock.json is missing');
  } else {
    const lock = readJson(lockPath);
    const rootSpec = lock.packages?.['']?.dependencies?.[RUNES_PACKAGE];
    if (rootSpec !== spec) problems.push(`package-lock.json records ${RUNES_PACKAGE} "${rootSpec}" for the root, package.json "${spec}"`);
    const entry = lock.packages?.[`node_modules/${RUNES_PACKAGE}`];
    if (entry === undefined) {
      problems.push(`package-lock.json has no entry for node_modules/${RUNES_PACKAGE}`);
    } else {
      if (entry.version !== spec) problems.push(`package-lock.json locks ${RUNES_PACKAGE} ${entry.version}, package.json pins ${spec}`);
      if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) problems.push(`package-lock.json has no sha512 integrity for ${RUNES_PACKAGE}`);
      const resolved = entry.resolved ?? '';
      if (resolved === REGISTRY(spec)) {
        // the registry tarball of the pinned version
      } else if (GITHUB_ARCHIVE.test(resolved)) {
        if (publish) problems.push(`${RUNES_PACKAGE} ${spec} is locked to the GitHub archive of a Runes commit (${resolved}), not the npm registry: publish Runes ${spec} to npm first, then run \`npm install ${RUNES_PACKAGE}@${spec} --save-exact\` in source/cli`);
      } else {
        problems.push(`package-lock.json fetches ${RUNES_PACKAGE} from ${resolved || '(nowhere)'}; only the npm registry tarball of ${spec} or the GitHub archive of a Runes commit is allowed`);
      }
    }
  }

  const installedPkg = path.join(cliRoot, 'node_modules', RUNES_PACKAGE, 'package.json');
  if (!existsSync(installedPkg)) {
    problems.push(`${RUNES_PACKAGE} is not installed in node_modules (run \`npm ci\`)`);
  } else {
    const installed = readJson(installedPkg).version;
    if (installed !== spec) problems.push(`node_modules holds ${RUNES_PACKAGE} ${installed}, package.json pins ${spec} (run \`npm ci\`)`);
  }
  if (runtimeVersion !== undefined && runtimeVersion !== spec) problems.push(`the code loads ${RUNES_PACKAGE} ${runtimeVersion}, package.json pins ${spec}`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let runtimeVersion;
  try {
    ({ version: runtimeVersion } = await import(`${RUNES_PACKAGE}/relations`));
  } catch {
    runtimeVersion = undefined; // not installed: runesPinProblems says so
  }
  const problems = runesPinProblems(cliRoot, { runtimeVersion, publish: process.argv.includes('--publish') });
  if (problems.length > 0) {
    process.stderr.write(`[runes-pin] FAIL:\n${problems.map((p) => `  - ${p}\n`).join('')}`);
    process.exit(1);
  }
  process.stdout.write(`[runes-pin] ${RUNES_PACKAGE} pinned at ${readJson(path.join(cliRoot, 'package.json')).dependencies[RUNES_PACKAGE]}, installed and loaded at that version\n`);
}
