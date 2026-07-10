import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { computeDetInputHash } from '../../../src/core/pair-hash.js';
import type { DetHashInput } from '../../../src/core/pair-hash.js';
import { ruleHashFor } from '../../../src/core/pair-inputs.js';
import type { AspectDef } from '../../../src/model/graph.js';

/**
 * G3-class hash guard: the `errs` label is rendering/analysis metadata ONLY and
 * must NEVER enter any verdict hash. Two independent proofs:
 *
 *   (1) Adding `errs: over` to a deterministic aspect's yaml leaves that pair's
 *       computeDetInputHash BYTE-IDENTICAL (with a non-vacuity check that errs was
 *       actually parsed, so the test can't pass by silently dropping the field).
 *   (2) The ingredient LIST of computeDetInputHash is unchanged — a fixed synthetic
 *       input hashes to a recorded constant. If a future edit folds errs (or any
 *       new field) into the deterministic hash, this constant changes and the test
 *       breaks — the tripwire that keeps errs out of the frozen contract.
 */

const createdDirs: string[] = [];

async function parseDetAspect(yaml: string): Promise<AspectDef> {
  const base = await mkdtemp(path.join(tmpdir(), 'yg-errs-hashguard-'));
  createdDirs.push(base);
  const aspectDir = path.join(base, 'example');
  await mkdir(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  await writeFile(yamlPath, yaml, 'utf-8');
  await writeFile(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
  const r = await parseAspect(aspectDir, yamlPath, 'example');
  if (!r.ok) throw new Error(`fixture parse failed: ${JSON.stringify(r.errors)}`);
  return r.aspect;
}

/** Build a DetHashInput whose hash-relevant fields are DERIVED from the parsed aspect. */
function detInputFor(aspect: AspectDef): DetHashInput {
  return {
    aspectId: aspect.id,
    scope: aspect.scope,
    nodePath: 'demo/node',
    ruleHash: ruleHashFor(aspect, 'check.mjs'),
    files: [['src/demo/a.ts', '2'.repeat(64)]],
    touched: [],
    verdict: 'approved',
  };
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('errs never enters the deterministic verdict hash (G3)', () => {
  it('adding errs: over to a deterministic aspect leaves computeDetInputHash byte-identical', async () => {
    const withoutErrs = await parseDetAspect(['name: T', 'description: x', ''].join('\n'));
    const withErrs = await parseDetAspect(['name: T', 'description: x', 'errs: over', ''].join('\n'));

    // Non-vacuity: errs was genuinely parsed on/off, so the equality below is meaningful.
    expect(withoutErrs.errs).toBeUndefined();
    expect(withErrs.errs).toBe('over');

    const hashWithout = computeDetInputHash(detInputFor(withoutErrs));
    const hashWith = computeDetInputHash(detInputFor(withErrs));
    expect(hashWith).toBe(hashWithout);
  });

  it('computeDetInputHash ingredient list is unchanged (fixed synthetic input → recorded constant)', () => {
    const fixed: DetHashInput = {
      aspectId: 'errs-hash-guard',
      scope: undefined,
      nodePath: 'demo/node',
      ruleHash: '1'.repeat(64),
      files: [['src/demo/a.ts', '2'.repeat(64)]],
      touched: [],
      verdict: 'approved',
    };
    // BREAKING: this constant pins the deterministic-hash ingredient set. If it
    // changes, a hash ingredient changed — a deliberate frozen-contract decision.
    expect(computeDetInputHash(fixed)).toBe(
      '420d564241b00f709f3bf81932f8484cfb5bc823366214e41cb3269c18ba35d7',
    );
  });
});
