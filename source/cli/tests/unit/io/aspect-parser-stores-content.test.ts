// `stores_content: false` marks a rule (one that detects secrets) whose refusals
// the local refused-content store keeps as the hash and the reason only. The
// parser carries the mark onto the model, from the rule's own file or a package
// rule's adaptation, and refuses a value that is not a boolean: a misspelled
// false read as "absent" would leave the copy of the secret in place.
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

const createdDirs: string[] = [];
afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function load(yaml: string) {
  const base = await mkdtemp(path.join(tmpdir(), 'yg-aspect-stores-content-'));
  createdDirs.push(base);
  const aspectDir = path.join(base, 'secrets');
  await mkdir(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  await writeFile(yamlPath, yaml, 'utf-8');
  await writeFile(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
  return parseAspect(aspectDir, yamlPath, 'secrets', { projectRoot: base });
}

describe('aspect-parser: stores_content', () => {
  it('carries stores_content: false onto the model', async () => {
    const r = await load('name: Secrets\ndescription: x\nstores_content: false\n');
    expect(r.ok && r.aspect.storesContent).toBe(false);
  });

  it('leaves the mark absent for true or no key — the store keeps the files', async () => {
    for (const yaml of ['name: S\ndescription: x\nstores_content: true\n', 'name: S\ndescription: x\n']) {
      const r = await load(yaml);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.aspect.storesContent).toBeUndefined();
    }
  });

  it('refuses a value that is not a boolean', async () => {
    const r = await load('name: S\ndescription: x\nstores_content: "no"\n');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('aspect-field-invalid');
    expect(JSON.stringify(r)).toContain('stores_content');
  });
});
