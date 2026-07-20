import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

// Each fixture gets its own mkdtemp directory under the OS temp dir. A previous
// version shared a single fixtures/tmp-aspect-status/ directory across all tests
// in this file; under vitest's parallel pool one test's afterEach cleanup could
// unlink fixtures another test (or another file) was mid-read on, causing
// intermittent ENOENT failures. Per-test temp dirs remove the shared state.
const createdDirs: string[] = [];

async function writeAspectFixture(yaml: string): Promise<{ aspectDir: string; yamlPath: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'yg-aspect-status-'));
  createdDirs.push(base);
  const aspectDir = path.join(base, 'example');
  await mkdir(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  await writeFile(yamlPath, yaml, 'utf-8');
  await writeFile(path.join(aspectDir, 'content.md'), 'rule', 'utf-8');
  return { aspectDir, yamlPath };
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('aspect-parser: status field', () => {
  it('accepts status: enforced', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: enforced
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBe('enforced');
  });

  it('accepts status: advisory', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: advisory
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBe('advisory');
  });

  it('accepts status: draft', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: draft
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBe('draft');
  });

  it('absent status field → undefined (resolver applies enforced default)', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBeUndefined();
  });

  it('rejects invalid status value', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: unstable
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map(e => e.code)).toContain('aspect-status-invalid');
    }
  });
});

describe('aspect-parser: implies status_inherit', () => {
  it('bare string implies → no status_inherit entry', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
implies:
  - some-other
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.implies).toEqual(['some-other']);
      expect(r.aspect.impliesStatusInherit?.['some-other']).toBeUndefined();
    }
  });

  it('object form with status_inherit: strictest', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
implies:
  - id: companion
    status_inherit: strictest
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.implies).toEqual(['companion']);
      expect(r.aspect.impliesStatusInherit?.['companion']).toBe('strictest');
    }
  });

  it('object form with status_inherit: own-default', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
implies:
  - id: companion
    status_inherit: own-default
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.impliesStatusInherit?.['companion']).toBe('own-default');
    }
  });

  it('rejects invalid status_inherit value', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
implies:
  - id: companion
    status_inherit: lax
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map(e => e.code)).toContain('implies-status-inherit-invalid');
    }
  });

  it('reports an unknown implies field as a structured error, not a throw', async () => {
    // An object entry under implies with an unknown key (not 'status_inherit')
    // must NOT be remapped to 'implies-status-inherit-invalid'. parseAspect's
    // contract is a {ok}|{ok:false,errors} union that never throws for a
    // validation failure — a malformed implies entry surfaces as the structured
    // code 'aspect-implies-invalid' with the underlying "unknown field" detail
    // preserved in the message (an uncaught throw here would abort the entire
    // graph load with a generic "this is a bug" message). Mirrors the
    // 'reports an implies object with an unknown field...' case in aspect-parser.test.ts.
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
implies:
  - id: companion
    bogus: x
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map(e => e.code)).toContain('aspect-implies-invalid');
      expect(r.errors[0].messageData.what).toMatch(/unknown field 'bogus'/);
    }
  });

});
