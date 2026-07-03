import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, ConfigParseError } from '../../../src/io/config-parser.js';

/**
 * Branch-coverage tests for yg-config.yaml rejection/normalization paths the primary
 * suite leaves uncovered: coverage-root list handling, an invalid max_direct_relations,
 * a malformed reviewer/auto_approve shape, and the per-tier validation gates (non-mapping
 * tier, non-string default, missing model, and the openai-compatible endpoint guard). A
 * malformed field must raise an actionable ConfigParseError rather than silently drop.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');
const TMP_PREFIX = 'tmp-cfgbc-';

let counter = 0;
/** Write `yaml` as a fresh temp yg-config.yaml and parse it, returning the parse promise. */
async function parse(yaml: string): Promise<Awaited<ReturnType<typeof parseConfig>>> {
  const dir = path.join(FIXTURES_DIR, `${TMP_PREFIX}${counter++}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'yg-config.yaml');
  await writeFile(file, yaml, 'utf-8');
  return parseConfig(file);
}

const TIER = 'reviewer:\n  tiers:\n    t:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n';

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith(TMP_PREFIX))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('config-parser — coverage roots', () => {
  it('accepts explicit required/excluded lists', async () => {
    const cfg = await parse('coverage:\n  required:\n    - services/\n  excluded:\n    - vendor/\n');
    expect(cfg.coverage?.required).toContain('services/');
    expect(cfg.coverage?.excluded).toContain('vendor/');
  });

  it('rejects a non-list coverage.excluded', async () => {
    await expect(parse('coverage:\n  excluded: notalist\n')).rejects.toThrow(
      /coverage\.excluded must be a list of strings/,
    );
  });
});

describe('config-parser — quality.max_direct_relations', () => {
  it('accepts a valid positive integer', async () => {
    const cfg = await parse('quality:\n  max_direct_relations: 7\n');
    expect(cfg.quality?.max_direct_relations).toBe(7);
  });

  it('rejects a non-positive value', async () => {
    await expect(parse('quality:\n  max_direct_relations: 0\n')).rejects.toThrow(
      /max_direct_relations must be a positive integer/,
    );
  });
});

describe('config-parser — malformed reviewer / auto_approve', () => {
  it('rejects a reviewer that is not a mapping', async () => {
    await expect(parse('reviewer: just-a-string\n')).rejects.toThrow(/unrecognized reviewer/);
  });

  it('rejects an unrecognized auto_approve value', async () => {
    await expect(parse(`${TIER}auto_approve: sometimes\n`)).rejects.toThrow(/auto_approve must be/);
  });
});

describe('config-parser — per-tier validation', () => {
  it('rejects a tier that is not a mapping', async () => {
    await expect(parse('reviewer:\n  tiers:\n    t: notamapping\n')).rejects.toThrow(
      /tier 't' is not a mapping/,
    );
  });

  it('rejects a non-string reviewer.default', async () => {
    await expect(parse(`${TIER}  default: 5\n`)).rejects.toThrow(/reviewer\.default must be a string/);
  });

  it('rejects a tier whose config has no model', async () => {
    const yaml = 'reviewer:\n  tiers:\n    t:\n      provider: ollama\n      consensus: 1\n      config:\n        temperature: 0\n';
    await expect(parse(yaml)).rejects.toThrow(/config\.model is missing/);
  });

  it('rejects an openai-compatible tier with no endpoint', async () => {
    const yaml =
      'reviewer:\n  tiers:\n    t:\n      provider: openai-compatible\n      consensus: 1\n      config:\n        model: gpt\n';
    await expect(parse(yaml)).rejects.toThrow(/missing config\.endpoint/);
  });

  it('surfaces every tier error as a ConfigParseError', async () => {
    await expect(parse('reviewer:\n  tiers:\n    t: notamapping\n')).rejects.toBeInstanceOf(ConfigParseError);
  });
});
