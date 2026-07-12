import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

/**
 * Parser coverage for the `review_by:` constitution field (spec RZ-18).
 *
 * review_by is a standing review-cadence date, valid on ANY aspect kind. It is
 * presence-gated and strict when present: a bare ISO calendar date (YYYY-MM-DD)
 * that is ALSO a real calendar date parses onto AspectDef.reviewBy; anything else
 * present is the blocking parse error aspect-review-by-malformed (a malformed date
 * must never silently never-fire). Absent → reviewBy undefined, no issue.
 */

const createdDirs: string[] = [];

async function writeAspectFixture(
  yaml: string,
  rule: 'check.mjs' | 'content.md',
): Promise<{ aspectDir: string; yamlPath: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'yg-aspect-review-by-'));
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
  return { aspectDir, yamlPath };
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('aspect-parser: review_by field', () => {
  // (a) valid bare date → parsed onto AspectDef.reviewBy. On an LLM aspect to
  // prove review_by is valid on ANY kind (not deterministic-only like errs).
  it('parses a valid review_by date onto the model (any aspect kind)', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'review_by: 2027-01-15', ''].join('\n'),
      'content.md',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('llm');
      expect(r.aspect.reviewBy).toBe('2027-01-15');
    }
  });

  it('also parses a valid review_by on a deterministic aspect', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'review_by: 2028-12-31', ''].join('\n'),
      'check.mjs',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('deterministic');
      expect(r.aspect.reviewBy).toBe('2028-12-31');
    }
  });

  // (b) out-of-range components → malformed (naming the required form).
  it('rejects an out-of-range date (2027-13-40) as aspect-review-by-malformed', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'review_by: 2027-13-40', ''].join('\n'),
      'content.md',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'aspect-review-by-malformed');
      expect(err).toBeDefined();
      // The message must name the required YYYY-MM-DD form and the offending value.
      const text = `${err!.messageData.what} ${err!.messageData.why} ${err!.messageData.next}`;
      expect(text).toContain('YYYY-MM-DD');
      expect(text).toContain('2027-13-40');
    }
  });

  // (c) wrong shape entirely → malformed (regex rejects it).
  it('rejects a non-ISO shape (15/01/2027) as aspect-review-by-malformed', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'review_by: "15/01/2027"', ''].join('\n'),
      'content.md',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'aspect-review-by-malformed')).toBe(true);
    }
  });

  // (d) calendar guard: shape is valid but the day does not exist.
  it('rejects an impossible calendar day (2027-02-30) via the calendar guard', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'review_by: 2027-02-30', ''].join('\n'),
      'content.md',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'aspect-review-by-malformed')).toBe(true);
    }
  });

  // (e) absent → undefined, no issue.
  it('absent review_by → reviewBy undefined, no issue', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', ''].join('\n'),
      'content.md',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewBy).toBeUndefined();
  });
});
