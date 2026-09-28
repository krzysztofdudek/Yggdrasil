#!/usr/bin/env node
// The cross-surface truth gate: every check that holds what the docs site, the
// knowledge topics, the agent manual (`yg prime`), the schema references and
// `--help` say to what the CLI does, run as one step. The family release loop
// runs it on the release branch before the tag (the releasing-the-family skill
// in the Vision hub), so a change described on only some surfaces cannot ship;
// every check is also part of the ordinary test run.
//
// The checks, by the surface-truth audit's recommendations (2026-09-25):
//   S1 the issue codes come from one registry
//   S2 every next step the CLI hands over is one it accepts, at the cost stated
//   S3 one schema per file format drives parsing, `yg schemas` and the docs tables
//   S4 every yg-*/1 document has a published JSON Schema, and every field is documented
//   S5 one CLI reference: the knowledge topic is the docs page, flags come from --help, every help example runs
//   S6 the manual and the knowledge topics say shared facts word for word
//   S7 a quoted message is one the CLI prints; the docs samples are recorded output
//   S8 every invariant the docs sell is held by a named test (the register in
//      tests/unit/repo/docs-claims.ts; its tests run here too)
//   S9 an absolute about what the CLI does is backed by a claim test or reviewed
//
// Usage: npm run surface-truth (in source/cli). Builds first: the e2e checks run
// the built CLI.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The tests the claim register names, read from the register itself so a new claim joins the gate. */
function claimedTests() {
  const register = readFileSync(path.join(CLI_ROOT, 'tests', 'unit', 'repo', 'docs-claims.ts'), 'utf8');
  return [...new Set([...register.matchAll(/file: '([^']+\.test\.ts)'/g)].map((m) => `tests/${m[1]}`))];
}

const GROUPS = [
  ['S1 issue-code registry', ['tests/unit/repo/issue-code-tables.test.ts']],
  ['S2 next steps run', ['tests/e2e/cli-next-executes.test.ts', 'tests/e2e/cli-next-contract.test.ts', 'tests/e2e/cli-next-cost-parity.test.ts']],
  ['S3 one schema per file format', ['tests/unit/repo/file-schema-tables.test.ts', 'tests/unit/repo/file-format-conformance.test.ts', 'tests/unit/repo/yaml-examples-parse.test.ts']],
  ['S4 JSON contracts', ['tests/unit/repo/json-contract-schemas.test.ts', 'tests/e2e/json-contract-documents.test.ts', 'tests/unit/repo/family-contracts-invariant.test.ts']],
  ['S5 one CLI reference', ['tests/e2e/cli-reference-truth.test.ts', 'tests/unit/repo/knowledge-cli-reference.test.ts', 'tests/unit/cli/help.test.ts']],
  ['S6 manual and knowledge agree', ['tests/unit/templates/agent-surface-truth.test.ts', 'tests/unit/repo/glossary-sync.test.ts']],
  ['S7 quoted output', ['tests/unit/repo/quoted-messages.test.ts', 'tests/e2e/docs-samples.test.ts', 'tests/e2e/docs-output-samples.test.ts', 'tests/e2e/cli-golden-corpus.test.ts']],
  ['S8 claim tests', ['tests/unit/repo/docs-claims.test.ts', ...claimedTests()]],
  ['S9 wording policy', ['tests/unit/repo/absolute-wording.test.ts']],
];

process.stdout.write('[surface-truth] cross-surface checks\n');
for (const [label, files] of GROUPS) process.stdout.write(`  ${label}: ${files.length} file${files.length === 1 ? '' : 's'}\n`);
// Vitest reads a path it cannot find as a filter that matches nothing, so a renamed
// check would silently leave the gate; name it instead.
const missing = GROUPS.flatMap(([, files]) => files).filter((f) => !existsSync(path.join(CLI_ROOT, f)));
if (missing.length > 0) {
  process.stderr.write(`[surface-truth] FAIL: the gate names check files that do not exist: ${missing.join(', ')} — update scripts/surface-truth.mjs\n`);
  process.exit(1);
}
const build = spawnSync('npm', ['run', 'build'], { cwd: CLI_ROOT, stdio: 'inherit' });
if (build.status !== 0) {
  process.stderr.write('[surface-truth] FAIL: the build failed, so the checks that run the CLI cannot run\n');
  process.exit(1);
}
const run = spawnSync('npx', ['vitest', 'run', ...new Set(GROUPS.flatMap(([, f]) => f))], { cwd: CLI_ROOT, stdio: 'inherit' });
process.stdout.write(run.status === 0 ? '[surface-truth] all checks passed\n' : '[surface-truth] FAIL: a surface says what the CLI does not (see the failing check above)\n');
process.exit(run.status ?? 1);
