import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { computeLlmInputHash, computeDetInputHash } from '../../../src/core/pair-hash.js';
import type { LlmHashInput, DetHashInput } from '../../../src/core/pair-hash.js';
import { ruleHashFor } from '../../../src/core/pair-inputs.js';
import type { AspectDef } from '../../../src/model/graph.js';

/**
 * G3-class hash guard (spec RZ-18): `review_by` is a constitution review-cadence
 * date — rendering/analysis metadata that must NEVER enter any verdict hash.
 * Recording or changing review_by on a rule must leave EVERY existing verdict
 * valid, so an aspect can carry a review-by date without re-billing a single
 * reviewer call.
 *
 * Unlike `errs` (deterministic-only), review_by is valid on ANY aspect kind, so
 * this guard proves the exclusion for BOTH hash directions:
 *
 *   (1) Adding `review_by: 2027-06-01` to an LLM aspect's yaml leaves that pair's
 *       computeLlmInputHash BYTE-IDENTICAL; the same for a deterministic aspect's
 *       computeDetInputHash. A non-vacuity check confirms review_by was actually
 *       parsed on/off, so the equality cannot pass by silently dropping the field.
 *   (2) The ingredient LIST of each hash function is unchanged — a fixed synthetic
 *       input hashes to a recorded constant. If a future edit folds review_by (or
 *       any new field) into either hash, the byte-identical proofs above could in
 *       principle be kept green by also editing the before/after fixture, but the
 *       pinned constants below would break — the tripwire that keeps review_by out
 *       of the frozen contract even against a coordinated edit.
 */

const createdDirs: string[] = [];

async function parseFixture(
  yaml: string,
  rule: 'content.md' | 'check.mjs',
): Promise<AspectDef> {
  const base = await mkdtemp(path.join(tmpdir(), 'yg-review-by-hashguard-'));
  createdDirs.push(base);
  const aspectDir = path.join(base, 'example');
  await mkdir(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  await writeFile(yamlPath, yaml, 'utf-8');
  if (rule === 'check.mjs') {
    await writeFile(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
  } else {
    await writeFile(path.join(aspectDir, 'content.md'), 'rule', 'utf-8');
  }
  const r = await parseAspect(aspectDir, yamlPath, 'example');
  if (!r.ok) throw new Error(`fixture parse failed: ${JSON.stringify(r.errors)}`);
  return r.aspect;
}

/** Build an LlmHashInput whose hash-relevant fields are DERIVED from the parsed aspect. */
function llmInputFor(aspect: AspectDef): LlmHashInput {
  return {
    aspectId: aspect.id,
    aspectDescription: aspect.description ?? '',
    scope: aspect.scope,
    nodePath: 'demo/node',
    ruleHash: ruleHashFor(aspect, 'content.md'),
    files: [['src/demo/a.ts', '2'.repeat(64)]],
    references: (aspect.references ?? []).map((r) => [r.path, '3'.repeat(64), r.description ?? ''] as [string, string, string]),
    tier: { name: 'standard' },
    verdict: 'approved',
  };
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

describe('review_by never enters any verdict hash (G3)', () => {
  it('adding review_by to an LLM aspect leaves computeLlmInputHash byte-identical', async () => {
    const without = await parseFixture(['name: T', 'description: x', ''].join('\n'), 'content.md');
    const withReviewBy = await parseFixture(
      ['name: T', 'description: x', 'review_by: 2027-06-01', ''].join('\n'),
      'content.md',
    );

    // Non-vacuity: review_by was genuinely parsed on/off, so the equality is meaningful.
    expect(without.reviewBy).toBeUndefined();
    expect(withReviewBy.reviewBy).toBe('2027-06-01');

    const hashWithout = computeLlmInputHash(llmInputFor(without));
    const hashWith = computeLlmInputHash(llmInputFor(withReviewBy));
    expect(hashWith).toBe(hashWithout);
  });

  it('adding review_by to a deterministic aspect leaves computeDetInputHash byte-identical', async () => {
    const without = await parseFixture(['name: T', 'description: x', ''].join('\n'), 'check.mjs');
    const withReviewBy = await parseFixture(
      ['name: T', 'description: x', 'review_by: 2027-06-01', ''].join('\n'),
      'check.mjs',
    );

    expect(without.reviewBy).toBeUndefined();
    expect(withReviewBy.reviewBy).toBe('2027-06-01');

    const hashWithout = computeDetInputHash(detInputFor(without));
    const hashWith = computeDetInputHash(detInputFor(withReviewBy));
    expect(hashWith).toBe(hashWithout);
  });

  it('computeLlmInputHash ingredient list is unchanged (fixed synthetic input → recorded constant)', () => {
    const fixed: LlmHashInput = {
      aspectId: 'review-by-hash-guard',
      aspectDescription: 'A rule whose review cadence must never touch its verdict.',
      scope: undefined,
      nodePath: 'demo/node',
      ruleHash: '1'.repeat(64),
      files: [['src/demo/a.ts', '2'.repeat(64)]],
      references: [],
      tier: { name: 'standard' },
      verdict: 'approved',
    };
    // BREAKING: this constant pins the LLM-hash ingredient set. If it changes, a
    // hash ingredient changed — a deliberate frozen-contract decision.
    expect(computeLlmInputHash(fixed)).toBe(
      '08b2200e62544beb7b1baeeed0f72bfbab9a203a157a85472b6734602a6ae99f',
    );
  });

  it('computeDetInputHash ingredient list is unchanged (fixed synthetic input → recorded constant)', () => {
    const fixed: DetHashInput = {
      aspectId: 'review-by-hash-guard',
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
      '0778919037b7ff31eb29ccde46db93c2c641a9b779fc09fec48ed0057f4defc6',
    );
  });

  // Schema-tolerance: review_by is an optional, tolerated field — an aspect yaml
  // carrying it alongside the rest of the schema (name, description, status)
  // parses clean with every other field intact and review_by set. This proves the
  // field is additive and never interferes with parsing the rest of the aspect.
  it('an aspect yaml carrying review_by parses clean, with the rest of the schema intact', async () => {
    const aspect = await parseFixture(
      ['name: T', 'description: a real description', 'status: advisory', 'review_by: 2030-03-14', ''].join('\n'),
      'content.md',
    );
    expect(aspect.reviewBy).toBe('2030-03-14');
    expect(aspect.description).toBe('a real description');
    expect(aspect.status).toBe('advisory');
    expect(aspect.reviewer.type).toBe('llm');
  });
});
