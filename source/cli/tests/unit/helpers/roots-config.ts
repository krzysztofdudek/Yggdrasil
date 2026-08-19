import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../../src/io/config-parser.js';
import type { RootsConfig } from '../../../src/model/graph.js';

/**
 * A fully-defaulted `RootsConfig`, driven through the PUBLIC `parseConfig`
 * (real yg-config.yaml in a real tmp dir — the same route `tests/unit/roots/
 * config.test.ts` uses) rather than a hand-built object literal, so every
 * roots test that needs "some valid config" exercises the real parser's
 * defaults instead of a second, hand-maintained copy of them that could
 * silently drift. `overridesYaml`, if given, is inserted INSIDE the `roots:`
 * mapping (indented two spaces by the caller) to override specific leaves —
 * e.g. `'enumerate:\n    support: { nodeType: 1, call: 1, import: 1, supertype: 1, shape: 1, decorator: 1 }\n'`.
 */
export async function defaultRootsConfig(overridesYaml = ''): Promise<RootsConfig> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-test-config-'));
  try {
    const filePath = path.join(dir, 'yg-config.yaml');
    const rootsBlock = overridesYaml.trim() === '' ? 'roots: {}\n' : `roots:\n  ${overridesYaml.split('\n').join('\n  ')}\n`;
    const body = `version: "5.2.0"\n${rootsBlock}`;
    await writeFile(filePath, body, 'utf-8');
    const cfg = await parseConfig(filePath, { skipSecretsOverlay: true });
    return cfg.roots as RootsConfig;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
