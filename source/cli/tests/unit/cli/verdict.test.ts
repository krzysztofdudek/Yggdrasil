// =============================================================================
// Unit — `yg verdict`, the external-judge channel.
//
// The channel's whole claim is that a judgement made outside the CLI is bound
// to the same content hashes a provider's would have been. These tests prove
// that from both ends: the package's hashes ARE the ones the fill stage would
// store (computed here from the shared assembly, not re-spelled), and the
// command refuses everything that would break the binding.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import { assembleReviewPackage } from '../../../src/core/review-package.js';
import { REVIEW_JSON_SCHEMA, VERDICTS_JSON_SCHEMA } from '../../../src/formatters/verdict-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const RULE = 'has-doc-comment';
const UNIT = 'services/orders';
const SUBJECT = path.join('src', 'services', 'orders.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-verdict-unit-'));
  cpSync(FIXTURE, dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

describe('yg verdict — the package is the fill stage\'s own', () => {
  it('prints the hashes the shared assembly computes, so a recorded verdict binds where a filled one would', async () => {
    const dir = copyFixture();
    if (!distExists) return;

    const doc = JSON.parse(run(['verdict', 'package', '--aspect', RULE, '--node', UNIT], dir).stdout) as {
      schema: string;
      hashes: { pass: string; refused: string };
      prompt: string;
      tier: { name: string; promptChars: number };
    };
    expect(doc.schema).toBe(REVIEW_JSON_SCHEMA);

    // The same assembly the fill stage uses, called directly. If the command
    // ever grew an assembly of its own, these two would drift and this fails.
    const graph = await loadGraph(dir);
    const { pairs } = await computeExpectedPairs(graph);
    const pair = pairs.find((p) => p.aspectId === RULE && p.unitKey === `node:${UNIT}`)!;
    const aspect = graph.aspects.find((a) => a.id === RULE)!;
    const assembled = await assembleReviewPackage({ graph, projectRoot: dir, pair, aspect, tierName: doc.tier.name });
    expect(assembled.kind).toBe('ok');
    if (assembled.kind !== 'ok') return;

    expect(doc.hashes.pass).toBe(assembled.pkg.hashFor('approved'));
    expect(doc.hashes.refused).toBe(assembled.pkg.hashFor('refused'));
    expect(doc.tier.promptChars).toBe(assembled.pkg.promptChars);
  });
});

describe.skipIf(!distExists)('yg verdict — what it refuses, and what it writes', () => {
  it('records a pass under the judge name and reports the hash it is bound to', () => {
    const dir = copyFixture();
    const doc = JSON.parse(run(['verdict', 'package', '--aspect', RULE, '--node', UNIT], dir).stdout) as {
      hashes: { pass: string };
    };
    const recorded = run(
      ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'a-verifier', '--verdict', 'pass', '--hash', doc.hashes.pass],
      dir,
    );
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain(`Recorded: ${RULE} on node:${UNIT} — pass, judged by 'a-verifier'.`);
    expect(recorded.stdout).toContain(doc.hashes.pass);
  });

  it('refuses a hash that belongs to the OTHER verdict token', () => {
    const dir = copyFixture();
    const doc = JSON.parse(run(['verdict', 'package', '--aspect', RULE, '--node', UNIT], dir).stdout) as {
      hashes: { pass: string; refused: string };
    };
    // The refused hash is a real hash of this very package — just not the one a
    // pass is stored under. Binding is per verdict token, not per package.
    const wrong = run(
      ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'a-verifier', '--verdict', 'pass', '--hash', doc.hashes.refused],
      dir,
    );
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('is not the hash of what is on disk now');
    expect(run(['verdict', 'read'], dir).stdout).toContain('No verdict in this graph was recorded');
  });

  it('refuses a package for a rule that runs as a local check', () => {
    const dir = copyFixture();
    const result = run(['verdict', 'package', '--aspect', 'requires-named-export', '--node', UNIT], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runs as a local check');
  });

  it('refuses naming both a component and a file', () => {
    const dir = copyFixture();
    const result = run(['verdict', 'package', '--aspect', RULE, '--node', UNIT, '--file', SUBJECT], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Conflicting options.');
  });

  it('refuses naming neither', () => {
    const dir = copyFixture();
    const result = run(['verdict', 'package', '--aspect', RULE], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No unit specified.');
  });

  it('refuses a rule the graph does not define', () => {
    const dir = copyFixture();
    const result = run(['verdict', 'package', '--aspect', 'no-such-rule', '--node', UNIT], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No rule 'no-such-rule' is defined in this graph.");
    expect(result.stderr).toContain('yg aspects');
  });

  it('lists nothing, in both views, on a graph nobody has judged this way', () => {
    const dir = copyFixture();
    expect(run(['verdict', 'read'], dir).stdout).toContain('No verdict in this graph was recorded by a judge outside the configured reviewer.');
    const doc = JSON.parse(run(['verdict', 'read', '--json'], dir).stdout) as { schema: string; verdicts: unknown[] };
    expect(doc.schema).toBe(VERDICTS_JSON_SCHEMA);
    expect(doc.verdicts).toEqual([]);
  });

  it('reports a recorded verdict as out of force once the code it judged has moved', () => {
    const dir = copyFixture();
    const doc = JSON.parse(run(['verdict', 'package', '--aspect', RULE, '--node', UNIT], dir).stdout) as {
      hashes: { pass: string };
    };
    run(['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'a-verifier', '--verdict', 'pass', '--hash', doc.hashes.pass], dir);
    appendFileSync(path.join(dir, SUBJECT), '\n// later\n');
    const listing = run(['verdict', 'read'], dir);
    expect(listing.stdout).toContain('(no longer in force: the inputs moved)');
  });
});
