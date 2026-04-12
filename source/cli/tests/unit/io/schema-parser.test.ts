import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchema } from '../../../src/io/schema-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('schema-parser', () => {
  it('infers schemaType from filename', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-schema-type');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-node.yaml'), 'name: Foo\ntype: service\n', 'utf-8');

    const s = await parseSchema(path.join(tmpDir, 'yg-node.yaml'));

    expect(s.schemaType).toBe('node');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('infers schemaType for aspect', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-schema-aspect');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-aspect.yaml'), 'name: RequiresX\ndescription: x\n', 'utf-8');

    const s = await parseSchema(path.join(tmpDir, 'yg-aspect.yaml'));

    expect(s.schemaType).toBe('aspect');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when file contains invalid YAML', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-schema-invalid');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-node.yaml'), ': invalid: yaml: [\n', 'utf-8');

    await expect(parseSchema(path.join(tmpDir, 'yg-node.yaml'))).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses raw filename when no yg- prefix', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-schema-raw');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'custom-schema.yaml'), 'name: Custom\n', 'utf-8');

    const s = await parseSchema(path.join(tmpDir, 'custom-schema.yaml'));

    expect(s.schemaType).toBe('custom-schema');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when YAML is not a mapping', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-schema-notobj');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-node.yaml'), '42\n', 'utf-8');

    await expect(parseSchema(path.join(tmpDir, 'yg-node.yaml'))).rejects.toThrow('expected YAML mapping');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('infers schemaType from .yml extension', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-schema-yml');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-flow.yml'), 'name: F\nnodes: []\n', 'utf-8');

    const s = await parseSchema(path.join(tmpDir, 'yg-flow.yml'));

    expect(s.schemaType).toBe('flow');

    await rm(tmpDir, { recursive: true, force: true });
  });
});
