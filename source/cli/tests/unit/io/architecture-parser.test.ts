import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('parseArchitecture', () => {
  async function writeTmp(fileName: string, content: string): Promise<string> {
    const tmpDir = path.join(__dirname, `../../fixtures/tmp-arch-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
    const file = path.join(tmpDir, fileName);
    await writeFile(file, content, 'utf-8');
    return file;
  }

  async function cleanup(file: string): Promise<void> {
    const dir = path.dirname(file);
    await rm(dir, { recursive: true, force: true });
  }

  it('parses minimal architecture with only descriptions', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  module:
    description: "Business logic unit"
  service:
    description: "Request handler"
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.module.description).toBe('Business logic unit');
    expect(arch.node_types.service.description).toBe('Request handler');
    expect(arch.node_types.module.aspects).toBeUndefined();
    await cleanup(file);
  });

  it('parses full architecture with all constraints', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth, error-format]
    parents: [module]
    relations:
      calls: [service, library]
      uses: [library]
`);
    const arch = await parseArchitecture(file);
    const svc = arch.node_types.service;
    expect(svc.aspects).toEqual(['requires-auth', 'error-format']);
    expect(svc.parents).toEqual(['module']);
    expect(svc.relations?.calls).toEqual(['service', 'library']);
    expect(svc.relations?.uses).toEqual(['library']);
    await cleanup(file);
  });

  it('throws on missing node_types', async () => {
    const file = await writeTmp('yg-architecture.yaml', `name: test`);
    await expect(parseArchitecture(file)).rejects.toThrow('node_types');
    await cleanup(file);
  });

  it('throws on missing description', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    aspects: [foo]
`);
    await expect(parseArchitecture(file)).rejects.toThrow('description');
    await cleanup(file);
  });

  it('throws on invalid relation type', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      depends: [library]
`);
    await expect(parseArchitecture(file)).rejects.toThrow('relation type');
    await cleanup(file);
  });

  it('parses all valid relation types', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: [library]
      calls: [service]
      extends: [base]
      implements: [interface]
      emits: [event]
      listens: [event]
`);
    const arch = await parseArchitecture(file);
    const rels = arch.node_types.service.relations;
    expect(rels?.uses).toEqual(['library']);
    expect(rels?.calls).toEqual(['service']);
    expect(rels?.extends).toEqual(['base']);
    expect(rels?.implements).toEqual(['interface']);
    expect(rels?.emits).toEqual(['event']);
    expect(rels?.listens).toEqual(['event']);
    await cleanup(file);
  });

  it('parses empty relations object', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations: {}
`);
    const arch = await parseArchitecture(file);
    const rels = arch.node_types.service.relations;
    expect(rels).toEqual({});
    await cleanup(file);
  });

  it('throws on non-array relation value', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: "library"
`);
    await expect(parseArchitecture(file)).rejects.toThrow('array');
    await cleanup(file);
  });

  it('throws on empty file', async () => {
    const file = await writeTmp('yg-architecture.yaml', '');
    await expect(parseArchitecture(file)).rejects.toThrow('empty');
    await cleanup(file);
  });

  it('allows node_types with only description (minimal valid entry)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  module:
    description: "unit"
  service:
    description: "handler"
  library:
    description: "utility"
`);
    const arch = await parseArchitecture(file);
    expect(Object.keys(arch.node_types)).toHaveLength(3);
    expect(arch.node_types.module.description).toBe('unit');
    expect(arch.node_types.service.description).toBe('handler');
    expect(arch.node_types.library.description).toBe('utility');
    await cleanup(file);
  });

  describe('architecture-parser v4 changes', () => {
    it('rejects integration_aspects as unknown field', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth]
    integration_aspects: [correlation-tracking]
`);
      await expect(parseArchitecture(file)).rejects.toThrow(/unknown field.*integration_aspects/i);
      await cleanup(file);
    });

    it('parses architecture without integration_aspects', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth]
    parents: [module]
`);
      const arch = await parseArchitecture(file);
      expect(arch.node_types.service.aspects).toEqual(['requires-auth']);
      expect(arch.node_types.service).not.toHaveProperty('integration_aspects');
      await cleanup(file);
    });
  });
});
