import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeYaml } from '../../../src/io/node-parser.js';

/**
 * Branch-coverage tests for the yg-node.yaml parser's rejection paths: malformed
 * `aspects` / `relations.consumes` / `ports` shapes each raise a specific, actionable
 * error rather than silently dropping the offending field (a silent drop would disable
 * enforcement the author expected). Each test feeds one malformed document and asserts
 * the concrete error, plus the empty-ports normalization that yields no ports at all.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');
const TMP_PREFIX = 'tmp-npbc-';

let counter = 0;
/** Write `yaml` to a fresh temp yg-node.yaml and parse it, returning the parse promise. */
async function parse(yaml: string): Promise<Awaited<ReturnType<typeof parseNodeYaml>>> {
  const dir = path.join(FIXTURES_DIR, `${TMP_PREFIX}${counter++}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'yg-node.yaml');
  await writeFile(file, yaml, 'utf-8');
  return parseNodeYaml(file);
}

const BASE = 'name: N\ntype: service\n';

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith(TMP_PREFIX))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('node-parser — aspects shape rejection', () => {
  it('rejects a non-array `aspects` value', async () => {
    await expect(parse(`${BASE}aspects: notalist\n`)).rejects.toThrow(/'aspects' must be an array/);
  });
});

describe('node-parser — relations.consumes shape rejection', () => {
  it('rejects a SINGLE non-string consumes entry (singular wording)', async () => {
    const yaml = `${BASE}relations:\n  - target: a/b\n    type: uses\n    consumes: [42]\n`;
    await expect(parse(yaml)).rejects.toThrow(/consumes contains non-string entry/);
  });

  it('rejects MULTIPLE non-string consumes entries (plural wording)', async () => {
    const yaml = `${BASE}relations:\n  - target: a/b\n    type: uses\n    consumes: [42, true]\n`;
    await expect(parse(yaml)).rejects.toThrow(/consumes contains non-string entries/);
  });

  it('rejects a SCALAR consumes value (must be an array of port names)', async () => {
    const yaml = `${BASE}relations:\n  - target: a/b\n    type: uses\n    consumes: charge\n`;
    await expect(parse(yaml)).rejects.toThrow(/consumes must be an array of string port names/);
  });

  it('accepts a valid string-array consumes', async () => {
    const yaml = `${BASE}relations:\n  - target: a/b\n    type: uses\n    consumes: [charge]\n`;
    const meta = await parse(yaml);
    expect(meta.relations?.[0].consumes).toEqual(['charge']);
  });
});

describe('node-parser — ports shape rejection', () => {
  it('rejects a `ports` value that is an array, not a mapping', async () => {
    await expect(parse(`${BASE}ports: []\n`)).rejects.toThrow(/ports must be a mapping/);
  });

  it('rejects a port definition that is not an object', async () => {
    await expect(parse(`${BASE}ports:\n  charge: notanobject\n`)).rejects.toThrow(
      /ports\.charge must be an object/,
    );
  });

  it('rejects a port whose `aspects` is not an array', async () => {
    const yaml = `${BASE}ports:\n  charge:\n    description: Charge a card\n    aspects: notalist\n`;
    await expect(parse(yaml)).rejects.toThrow(/ports\.charge\.aspects must be an array/);
  });

  it('rejects a port that lists the same aspect twice', async () => {
    const yaml = `${BASE}ports:\n  charge:\n    description: Charge a card\n    aspects: [audit, audit]\n`;
    await expect(parse(yaml)).rejects.toThrow(/ports\.charge\.aspects has duplicate 'audit'/);
  });
});

describe('node-parser — empty ports normalization', () => {
  it('treats an empty `ports: {}` mapping as no ports at all', async () => {
    const meta = await parse(`${BASE}ports: {}\n`);
    expect(meta.ports).toBeUndefined();
  });
});
