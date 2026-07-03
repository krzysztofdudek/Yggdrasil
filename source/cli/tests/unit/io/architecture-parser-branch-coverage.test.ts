import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';

/**
 * Branch-coverage tests for the architecture parser's relation-list rejection paths: a
 * `relations` value that is not a mapping, and relation target lists that contain
 * non-string entries (both the singular and plural wording). A silently-dropped target
 * name would remove an intended architectural constraint without warning.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function writeArch(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-bc-'));
  dirs.push(dir);
  const file = path.join(dir, 'yg-architecture.yaml');
  await writeFile(file, body, 'utf-8');
  return file;
}

describe('architecture-parser — relation-list rejection', () => {
  it('rejects a relations value that is not a mapping', async () => {
    const file = await writeArch('node_types:\n  service:\n    description: "x"\n    relations: [1, 2]\n');
    await expect(parseArchitecture(file)).rejects.toThrow(/relations must be an object/);
  });

  it('rejects a SINGLE non-string relation target (singular wording)', async () => {
    const file = await writeArch(
      'node_types:\n  service:\n    description: "x"\n    relations:\n      uses: [42]\n',
    );
    await expect(parseArchitecture(file)).rejects.toThrow(/contains non-string entry/);
  });

  it('rejects MULTIPLE non-string relation targets (plural wording)', async () => {
    const file = await writeArch(
      'node_types:\n  service:\n    description: "x"\n    relations:\n      uses: [42, 43]\n',
    );
    await expect(parseArchitecture(file)).rejects.toThrow(/contains non-string entries/);
  });

  it('accepts a well-formed relation target list (control)', async () => {
    const file = await writeArch(
      'node_types:\n  service:\n    description: "x"\n    relations:\n      uses: [repo]\n  repo:\n    description: "r"\n',
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.relations?.uses).toEqual(['repo']);
  });
});
