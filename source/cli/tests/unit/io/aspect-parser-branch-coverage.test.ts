import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect, type ParseAspectResult } from '../../../src/io/aspect-parser.js';

/**
 * Branch-coverage tests for the aspect parser's rejection paths: an empty aspect id, a
 * non-array `references`, and a reference entry object with no string `path`. Each is an
 * author mistake that must surface a specific error rather than a silently ignored field.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Create an aspect dir with the given yg-aspect.yaml (+ a content.md so it reads as LLM). */
async function aspectDir(yaml: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-asp-bc-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'yg-aspect.yaml'), yaml, 'utf-8');
  await writeFile(path.join(dir, 'content.md'), 'The rule.', 'utf-8');
  return dir;
}

function fail(r: ParseAspectResult): ReadonlyArray<{ code: string }> {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected failure');
  return r.errors;
}

describe('aspect-parser — rejection paths', () => {
  it('rejects an empty aspect id', async () => {
    const r = await parseAspect('/nonexistent', '/nonexistent/yg-aspect.yaml', '   ');
    expect(fail(r).some((e) => e.code === 'aspect-invalid-id')).toBe(true);
  });

  it('rejects a non-array references value', async () => {
    const dir = await aspectDir('name: T\nreviewer:\n  type: llm\nreferences: notalist\n');
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'sample');
    expect(fail(r).some((e) => e.code === 'aspect-reference-invalid-form')).toBe(true);
  });

  it('rejects a reference entry object that has no string path', async () => {
    const dir = await aspectDir('name: T\nreviewer:\n  type: llm\nreferences:\n  - description: no path here\n');
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'sample');
    expect(r.ok).toBe(false);
  });

  it('accepts a valid string-form reference (control)', async () => {
    const dir = await aspectDir('name: T\nreviewer:\n  type: llm\nreferences:\n  - docs/rule.md\n');
    const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'sample');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.references?.[0].path).toBe('docs/rule.md');
  });
});
