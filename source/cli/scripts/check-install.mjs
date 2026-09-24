#!/usr/bin/env node
// Does source/cli/node_modules hold what package-lock.json says? A tree installed
// against an older lock keeps working just well enough to mislead: tests, the
// build and the grammar pipeline run against a different web-tree-sitter or
// vitest than CI and every fresh clone, so a result here says nothing about the
// committed state. repo-check runs this first and stops on a mismatch.
//
// Compares every package the lock pins (its `packages` entries under
// node_modules/) with the version installed at that path. An optional package
// the lock lists but this platform did not install (the per-platform binaries
// of esbuild, rollup, …) is fine; any other missing package or version
// difference is a mismatch.
//
// Usage: node scripts/check-install.mjs [<package dir>]   (default: source/cli)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const lockPath = path.join(root, 'package-lock.json');
if (!existsSync(lockPath)) {
  process.stderr.write(`[check-install] FAIL: no package-lock.json in ${root}\n`);
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const problems = [];
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (!key.startsWith('node_modules/') && !key.includes('/node_modules/')) continue;
  if (entry.link) continue;
  const pkgJson = path.join(root, key, 'package.json');
  if (!existsSync(pkgJson)) {
    if (entry.optional || entry.devOptional || entry.peer) continue;
    problems.push(`${key.replace(/^node_modules\//, '')}: missing (lock: ${entry.version})`);
    continue;
  }
  let installed;
  try {
    installed = JSON.parse(readFileSync(pkgJson, 'utf8')).version;
  } catch {
    installed = '(unreadable package.json)';
  }
  if (entry.version !== undefined && installed !== entry.version) {
    problems.push(`${key.replace(/^node_modules\//, '')}: installed ${installed}, lock ${entry.version}`);
  }
}

if (problems.length > 0) {
  const shown = problems.slice(0, 12);
  process.stderr.write(
    `[check-install] FAIL: ${path.join(root, 'node_modules')} does not match package-lock.json (${problems.length} package${problems.length === 1 ? '' : 's'}):\n` +
      shown.map((p) => `  - ${p}\n`).join('') +
      (problems.length > shown.length ? `  … and ${problems.length - shown.length} more\n` : '') +
      `Why: the build and the tests would run against other versions than CI and a fresh clone.\n` +
      `Fix: run \`npm ci\` in ${root} (it reinstalls exactly the lock).\n`,
  );
  process.exit(1);
}
process.stdout.write(`[check-install] node_modules matches package-lock.json (${root})\n`);
