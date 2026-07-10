import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

// Each fixture gets its own mkdtemp directory (parallel-pool safe — a shared
// dir lets one test's afterEach unlink another test's fixtures mid-read).
const createdDirs: string[] = [];

/**
 * Write an aspect fixture. `rule` selects the rule-source file that drives kind
 * inference: 'check.mjs' → deterministic, 'content.md' → llm.
 */
async function writeAspectFixture(
  yaml: string,
  rule: 'check.mjs' | 'content.md',
): Promise<{ aspectDir: string; yamlPath: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'yg-aspect-errs-'));
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

describe('aspect-parser: errs field', () => {
  it('parses errs: under onto the model for a deterministic aspect', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'errs: under', ''].join('\n'),
      'check.mjs',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('deterministic');
      expect(r.aspect.errs).toBe('under');
    }
  });

  it('accepts each of the three literals: over, under, exact', async () => {
    for (const value of ['over', 'under', 'exact'] as const) {
      const { aspectDir, yamlPath } = await writeAspectFixture(
        ['name: Example', 'description: x', `errs: ${value}`, ''].join('\n'),
        'check.mjs',
      );
      const r = await parseAspect(aspectDir, yamlPath, 'example');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.aspect.errs).toBe(value);
    }
  });

  it('rejects an invalid errs literal, naming the valid values', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'errs: banana', ''].join('\n'),
      'check.mjs',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'aspect-errs-invalid');
      expect(err).toBeDefined();
      // The message must name the three valid values so the fix is obvious.
      const text = `${err!.messageData.what} ${err!.messageData.why} ${err!.messageData.next}`;
      expect(text).toContain('over');
      expect(text).toContain('under');
      expect(text).toContain('exact');
    }
  });

  it('absent errs → undefined, no issue', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', ''].join('\n'),
      'check.mjs',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.errs).toBeUndefined();
  });

  it('parser TOLERATES a valid errs literal on an LLM aspect (cross-field check is the validator\'s job)', async () => {
    // The literal `over` is valid, so the parser stores it. Whether errs is legal
    // on an LLM aspect is a cross-field contract enforced downstream (checkAspectErrsDirection).
    const { aspectDir, yamlPath } = await writeAspectFixture(
      ['name: Example', 'description: x', 'errs: over', ''].join('\n'),
      'content.md',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('llm');
      expect(r.aspect.errs).toBe('over');
    }
  });
});
